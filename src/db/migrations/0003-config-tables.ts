import type { Migration } from "@/db/migrator";

/**
 * v2 configuration (PRD §3.2, §4.1, §4.5, §7): versioned goal configs and scorecards, their metrics, the shared
 * failure-condition library and each scorecard's conditions. A draft holds the next version number (one draft per
 * lineage); publishing sets `status = 'published'`, after which the triggers below reject any change to that version,
 * its metrics and conditions, or a library condition it uses.
 *
 * Which scorecard an agent uses is not part of a version: `scorecard_assignment` points each agent at one published
 * version, so attaching an agent never creates a version (and never breaks other agents' trend lines).
 */
export const up: Migration = async ({ context: sequelize }) => {
  await sequelize.transaction(async (transaction) => {
    await sequelize.query(
      `CREATE TABLE failure_condition (
        code VARCHAR(255) PRIMARY KEY,
        label TEXT NOT NULL,
        definition TEXT NOT NULL,
        default_severity VARCHAR(255) NOT NULL CONSTRAINT failure_condition_default_severity_check
          CHECK (default_severity IN ('critical', 'major', 'minor')),
        rolls_up_to TEXT[] NOT NULL DEFAULT '{}',
        detection VARCHAR(255) NOT NULL CONSTRAINT failure_condition_detection_check CHECK (detection IN ('rule', 'llm')),
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
      );

      CREATE TABLE goal_config (
        agent_code VARCHAR(255) NOT NULL,
        version INTEGER NOT NULL CONSTRAINT goal_config_version_check CHECK (version > 0),
        status VARCHAR(255) NOT NULL DEFAULT 'draft' CONSTRAINT goal_config_status_check CHECK (status IN ('draft', 'published')),
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        success_criteria TEXT[] NOT NULL DEFAULT '{}',
        partial_success TEXT[] NOT NULL DEFAULT '{}',
        not_applicable_when TEXT[] NOT NULL DEFAULT '{}',
        required_outputs TEXT[] NOT NULL DEFAULT '{}',
        reason_codes JSONB NOT NULL DEFAULT '{}',
        system_checks JSONB NOT NULL DEFAULT '{}',
        created_by VARCHAR(255),
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        published_at TIMESTAMP WITH TIME ZONE,
        PRIMARY KEY (agent_code, version)
      );
      CREATE UNIQUE INDEX goal_config_one_draft ON goal_config (agent_code) WHERE status = 'draft';

      CREATE TABLE scorecard (
        scorecard_id VARCHAR(255) NOT NULL,
        version INTEGER NOT NULL CONSTRAINT scorecard_version_check CHECK (version > 0),
        status VARCHAR(255) NOT NULL DEFAULT 'draft' CONSTRAINT scorecard_status_check CHECK (status IN ('draft', 'published')),
        name TEXT NOT NULL,
        based_on INTEGER,
        pass_threshold NUMERIC(5,1) NOT NULL DEFAULT 40 CONSTRAINT scorecard_pass_threshold_check CHECK (pass_threshold BETWEEN 0 AND 100),
        fail_score_cap INTEGER,
        created_by VARCHAR(255),
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        published_at TIMESTAMP WITH TIME ZONE,
        PRIMARY KEY (scorecard_id, version)
      );
      CREATE UNIQUE INDEX scorecard_one_draft ON scorecard (scorecard_id) WHERE status = 'draft';

      CREATE TABLE scorecard_assignment (
        agent_code VARCHAR(255) PRIMARY KEY,
        scorecard_id VARCHAR(255) NOT NULL,
        scorecard_version INTEGER NOT NULL,
        assigned_by VARCHAR(255),
        assigned_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        FOREIGN KEY (scorecard_id, scorecard_version) REFERENCES scorecard (scorecard_id, version)
      );

      CREATE TABLE metric (
        id SERIAL PRIMARY KEY,
        scorecard_id VARCHAR(255) NOT NULL,
        scorecard_version INTEGER NOT NULL,
        key VARCHAR(255) NOT NULL,
        position INTEGER NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        rubric JSONB NOT NULL,
        applicability TEXT NOT NULL DEFAULT '',
        method VARCHAR(255) NOT NULL CONSTRAINT metric_method_check CHECK (method IN ('llm', 'rule', 'audio', 'hybrid')),
        weight NUMERIC(4,1) NOT NULL CONSTRAINT metric_weight_check CHECK (weight BETWEEN 0 AND 100),
        scale INTEGER NOT NULL DEFAULT 10 CONSTRAINT metric_scale_check CHECK (scale > 0),
        auto_fail BOOLEAN NOT NULL DEFAULT false,
        evidence_required BOOLEAN NOT NULL DEFAULT true,
        requires VARCHAR(255)[] NOT NULL DEFAULT '{}'
          CONSTRAINT metric_requires_check CHECK (requires <@ ARRAY['audio', 'timestamps', 'tool_calls']::VARCHAR(255)[]),
        params JSONB NOT NULL DEFAULT '{}',
        FOREIGN KEY (scorecard_id, scorecard_version) REFERENCES scorecard (scorecard_id, version) ON DELETE CASCADE,
        UNIQUE (scorecard_id, scorecard_version, key),
        UNIQUE (scorecard_id, scorecard_version, position)
      );

      CREATE TABLE scorecard_condition (
        scorecard_id VARCHAR(255) NOT NULL,
        scorecard_version INTEGER NOT NULL,
        condition_code VARCHAR(255) NOT NULL REFERENCES failure_condition (code),
        enabled BOOLEAN NOT NULL DEFAULT true,
        severity VARCHAR(255) NOT NULL CONSTRAINT scorecard_condition_severity_check CHECK (severity IN ('critical', 'major', 'minor')),
        metric_key VARCHAR(255),
        PRIMARY KEY (scorecard_id, scorecard_version, condition_code),
        FOREIGN KEY (scorecard_id, scorecard_version) REFERENCES scorecard (scorecard_id, version) ON DELETE CASCADE
      );

      -- A published scorecard or goal config never changes or disappears.
      CREATE FUNCTION config_published_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.status = 'published' THEN
          RAISE EXCEPTION '% version % is published and cannot be changed', TG_TABLE_NAME, OLD.version;
        END IF;
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER scorecard_immutable BEFORE UPDATE OR DELETE ON scorecard
        FOR EACH ROW EXECUTE FUNCTION config_published_immutable();
      CREATE TRIGGER goal_config_immutable BEFORE UPDATE OR DELETE ON goal_config
        FOR EACH ROW EXECUTE FUNCTION config_published_immutable();

      -- Metrics and conditions of a published scorecard can't be added, changed or removed.
      CREATE FUNCTION scorecard_part_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP <> 'INSERT' AND EXISTS (SELECT 1 FROM scorecard s WHERE s.scorecard_id = OLD.scorecard_id
            AND s.version = OLD.scorecard_version AND s.status = 'published') THEN
          RAISE EXCEPTION '% of published scorecard % version % cannot be changed', TG_TABLE_NAME, OLD.scorecard_id, OLD.scorecard_version;
        END IF;
        IF TG_OP <> 'DELETE' AND EXISTS (SELECT 1 FROM scorecard s WHERE s.scorecard_id = NEW.scorecard_id
            AND s.version = NEW.scorecard_version AND s.status = 'published') THEN
          RAISE EXCEPTION '% of published scorecard % version % cannot be changed', TG_TABLE_NAME, NEW.scorecard_id, NEW.scorecard_version;
        END IF;
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER metric_immutable BEFORE INSERT OR UPDATE OR DELETE ON metric
        FOR EACH ROW EXECUTE FUNCTION scorecard_part_immutable();
      CREATE TRIGGER scorecard_condition_immutable BEFORE INSERT OR UPDATE OR DELETE ON scorecard_condition
        FOR EACH ROW EXECUTE FUNCTION scorecard_part_immutable();

      -- A library condition used by a published scorecard keeps its wording: add a new code instead.
      CREATE FUNCTION failure_condition_in_use() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM scorecard_condition c JOIN scorecard s ON s.scorecard_id = c.scorecard_id
            AND s.version = c.scorecard_version WHERE c.condition_code = OLD.code AND s.status = 'published') THEN
          RAISE EXCEPTION 'failure condition % is used by a published scorecard and cannot be changed', OLD.code;
        END IF;
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER failure_condition_immutable BEFORE UPDATE OR DELETE ON failure_condition
        FOR EACH ROW EXECUTE FUNCTION failure_condition_in_use();

      -- Agents are only ever pointed at a published version with at least 10 metrics (PRD §4.3), never a draft. The
      -- 5 × 20 templates stay only so v1 audits can say what they were graded on.
      CREATE FUNCTION scorecard_assignment_published() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM scorecard s WHERE s.scorecard_id = NEW.scorecard_id AND s.version = NEW.scorecard_version
            AND s.status = 'published') THEN
          RAISE EXCEPTION 'scorecard % version % is not published, so no agent can use it', NEW.scorecard_id, NEW.scorecard_version;
        END IF;
        IF (SELECT count(*) FROM metric m WHERE m.scorecard_id = NEW.scorecard_id AND m.scorecard_version = NEW.scorecard_version) < 10 THEN
          RAISE EXCEPTION 'scorecard % version % has fewer than 10 metrics, so no agent can use it', NEW.scorecard_id, NEW.scorecard_version;
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER scorecard_assignment_published BEFORE INSERT OR UPDATE ON scorecard_assignment
        FOR EACH ROW EXECUTE FUNCTION scorecard_assignment_published();`,
      { transaction },
    );
  });
};

export const down: Migration = async ({ context: sequelize }) => {
  await sequelize.query(
    `DROP TABLE scorecard_assignment, scorecard_condition, metric, scorecard, goal_config, failure_condition;
     DROP FUNCTION config_published_immutable(), scorecard_part_immutable(), failure_condition_in_use(), scorecard_assignment_published();`,
  );
};
