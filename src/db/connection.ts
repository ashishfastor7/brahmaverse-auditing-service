import { env } from "@/env";
import { Sequelize } from "sequelize";

export const sequelize = new Sequelize(env.DB_NAME, env.DB_USERNAME, env.DB_PASSWORD, {
  dialect: "postgres",
  host: env.DB_HOSTNAME,
  port: env.DB_PORT,
  logging: false,
  dialectOptions: env.DB_SSL ? { ssl: { require: true, rejectUnauthorized: false } } : {},
  pool: { max: 10, min: 0, acquire: 20_000, idle: 10_000 },
});
