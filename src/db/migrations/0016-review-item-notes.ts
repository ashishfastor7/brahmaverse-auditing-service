import type { Migration } from "@/db/migrator";

/**
 * P2-4: one review can dispute several items, each with its own note. `item_notes` maps the item to its note:
 * `metric:<key>`, `check:<S1–S4>`, `business_outcome`, `code:<failure code>` (a code added or removed). `note` stays the
 * review's overall comment. The golden set doesn't read it.
 */
export const up: Migration = async ({ context: sequelize }) => {
  await sequelize.query(
    `ALTER TABLE review
      ADD COLUMN item_notes JSONB CONSTRAINT review_item_notes_check CHECK (jsonb_typeof(item_notes) = 'object');`,
  );
};

export const down: Migration = async ({ context: sequelize }) => {
  await sequelize.query("ALTER TABLE review DROP COLUMN item_notes");
};
