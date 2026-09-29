CREATE DATABASE IF NOT EXISTS taskerph_db CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE taskerph_db;

CREATE TABLE IF NOT EXISTS users (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    first_name VARCHAR(80) NOT NULL,
    middle_initial VARCHAR(5) NULL,
    last_name VARCHAR(80) NOT NULL,
    email VARCHAR(190) NOT NULL UNIQUE,
    password VARCHAR(255) NOT NULL,
    role ENUM('superadmin', 'admin', 'user') NOT NULL DEFAULT 'user',
    avatar_path VARCHAR(255) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS tasks (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id INT UNSIGNED NOT NULL,
    title VARCHAR(180) NOT NULL,
    category VARCHAR(80) NOT NULL,
    budget DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    location VARCHAR(160) NOT NULL,
    description TEXT NOT NULL,
    status ENUM('Open', 'In Progress', 'Completed') NOT NULL DEFAULT 'Open',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_tasks_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_tasks_status (status),
    INDEX idx_tasks_category (category),
    INDEX idx_tasks_created_id (created_at, id),
    INDEX idx_tasks_status_created (status, created_at, id),
    INDEX idx_tasks_category_created (category, created_at, id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS bids (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    task_id INT UNSIGNED NOT NULL,
    bidder_id INT UNSIGNED NOT NULL,
    amount DECIMAL(10, 2) NOT NULL,
    message VARCHAR(1000) NOT NULL,
    status ENUM('Pending', 'Accepted', 'Rejected') NOT NULL DEFAULT 'Pending',
    removal_reason VARCHAR(1000) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_bids_task FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
    CONSTRAINT fk_bids_bidder FOREIGN KEY (bidder_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE KEY uq_bid_task_user (task_id, bidder_id),
    INDEX idx_bids_status (status),
    INDEX idx_bids_status_task (status, task_id),
    INDEX idx_bids_task_created (task_id, created_at),
    INDEX idx_bids_bidder_created (bidder_id, created_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS messages (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    task_id INT UNSIGNED NOT NULL,
    sender_id INT UNSIGNED NOT NULL,
    recipient_id INT UNSIGNED NOT NULL,
    body VARCHAR(2000) NOT NULL,
    read_at TIMESTAMP NULL DEFAULT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_messages_task FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
    CONSTRAINT fk_messages_sender FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_messages_recipient FOREIGN KEY (recipient_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_messages_thread (task_id, sender_id, recipient_id, created_at),
    INDEX idx_messages_task_recipient_read (task_id, recipient_id, read_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS notification_reads (
    user_id INT UNSIGNED NOT NULL,
    notification_type ENUM('bid') NOT NULL,
    reference_id INT UNSIGNED NOT NULL,
    read_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, notification_type, reference_id),
    CONSTRAINT fk_notification_reads_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS saved_tasks (
    user_id INT UNSIGNED NOT NULL,
    task_id INT UNSIGNED NOT NULL,
    saved_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, task_id),
    CONSTRAINT fk_saved_tasks_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_saved_tasks_task FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
    INDEX idx_saved_tasks_saved_at (user_id, saved_at)
) ENGINE=InnoDB;

INSERT INTO users (first_name, last_name, email, password, role)
SELECT 'Super', 'Admin', 'superadmin@gmail.com', '$2y$10$WHexnyY1Wxtyjp2DEpHwkeEtGlEcn.e8QAZ8cG4OW5WS0X8ZNhtPG', 'superadmin'
WHERE NOT EXISTS (SELECT 1 FROM users WHERE email = 'superadmin@gmail.com');
