-- Apply once to an existing local MySQL/MariaDB database. The guarded DDL
-- avoids duplicate-index errors if an index is already present.
USE taskerph_db;

SET @ddl = IF((SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'tasks' AND index_name = 'idx_tasks_created_id') = 0, 'ALTER TABLE tasks ADD INDEX idx_tasks_created_id (created_at, id)', 'SELECT 1');
PREPARE taskerph_stmt FROM @ddl; EXECUTE taskerph_stmt; DEALLOCATE PREPARE taskerph_stmt;
SET @ddl = IF((SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'tasks' AND index_name = 'idx_tasks_status_created') = 0, 'ALTER TABLE tasks ADD INDEX idx_tasks_status_created (status, created_at, id)', 'SELECT 1');
PREPARE taskerph_stmt FROM @ddl; EXECUTE taskerph_stmt; DEALLOCATE PREPARE taskerph_stmt;
SET @ddl = IF((SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'tasks' AND index_name = 'idx_tasks_category_created') = 0, 'ALTER TABLE tasks ADD INDEX idx_tasks_category_created (category, created_at, id)', 'SELECT 1');
PREPARE taskerph_stmt FROM @ddl; EXECUTE taskerph_stmt; DEALLOCATE PREPARE taskerph_stmt;
SET @ddl = IF((SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'bids' AND index_name = 'idx_bids_status_task') = 0, 'ALTER TABLE bids ADD INDEX idx_bids_status_task (status, task_id)', 'SELECT 1');
PREPARE taskerph_stmt FROM @ddl; EXECUTE taskerph_stmt; DEALLOCATE PREPARE taskerph_stmt;
SET @ddl = IF((SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'messages' AND index_name = 'idx_messages_task_recipient_read') = 0, 'ALTER TABLE messages ADD INDEX idx_messages_task_recipient_read (task_id, recipient_id, read_at)', 'SELECT 1');
PREPARE taskerph_stmt FROM @ddl; EXECUTE taskerph_stmt; DEALLOCATE PREPARE taskerph_stmt;
