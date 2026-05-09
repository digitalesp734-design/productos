const { Sequelize } = require('sequelize');

const dbUrl = process.env.DATABASE_URL || process.env.MYSQL_URL;

const sequelize = dbUrl
    ? new Sequelize(dbUrl, {
        dialect: 'mysql', logging: false,
        pool: { max: 5, min: 0, acquire: 30000, idle: 10000 },
        dialectOptions: { ssl: false }
    })
    : new Sequelize(
        process.env.DB_NAME || 'product_digital',
        process.env.DB_USER || 'root',
        process.env.DB_PASS || '',
        { host: process.env.DB_HOST || 'localhost', port: parseInt(process.env.DB_PORT) || 3306, dialect: 'mysql', logging: false }
    );

module.exports = sequelize;
