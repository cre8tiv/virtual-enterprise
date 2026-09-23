-- Legacy on-prem manufacturing / warehouse system database (tables created by the canonical loaders).
-- Idempotent; run by the sqlserver-init service with -v SUT_READER_PASSWORD=...

IF DB_ID('Operations') IS NULL
    CREATE DATABASE Operations;
GO

IF NOT EXISTS (SELECT 1 FROM sys.server_principals WHERE name = 'sut_reader')
    CREATE LOGIN sut_reader WITH PASSWORD = '$(SUT_READER_PASSWORD)', CHECK_POLICY = ON;
GO

USE Operations;
GO

IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = 'sut_reader')
BEGIN
    CREATE USER sut_reader FOR LOGIN sut_reader;
    ALTER ROLE db_datareader ADD MEMBER sut_reader;
END
GO
