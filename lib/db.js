const { Sequelize, DataTypes } = require("sequelize");
const path = require("path");

const sequelize = new Sequelize({
  dialect: "sqlite",
  storage: path.join(__dirname, "../database.sqlite"),
  logging: false, // disable logging for cleaner output
});

const User = sequelize.define(
  "User",
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    email: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
    },
    password: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    name: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    stripe_customer_id: {
      type: DataTypes.STRING(255),
      unique: true,
    },
    subscription_status: {
      type: DataTypes.STRING(50),
      defaultValue: "none",
    },
    subscription_plan: {
      type: DataTypes.STRING(100),
    },
    current_period_end: {
      type: DataTypes.DATE,
    },
    trial_end: {
      type: DataTypes.DATE,
    },
  },
  {
    tableName: "users",
    timestamps: true,
  },
);

module.exports = {
  sequelize,
  User,
};
