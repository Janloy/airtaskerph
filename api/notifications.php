<?php
declare(strict_types=1);
require_once __DIR__ . '/../config/db.php';

try {
    $user = require_login();
    $action = $_GET['action'] ?? request_data()['action'] ?? 'counts';

    if ($action === 'counts') {
        $statement = db()->prepare('SELECT
            (SELECT COUNT(*) FROM bids b JOIN tasks t ON t.id = b.task_id LEFT JOIN notification_reads nr ON nr.user_id = ? AND nr.notification_type = \'bid\' AND nr.reference_id = b.id WHERE t.user_id = ? AND b.status = \'Pending\' AND nr.reference_id IS NULL) AS pending_bids,
            (SELECT COUNT(*) FROM messages WHERE recipient_id = ? AND read_at IS NULL AND EXISTS(SELECT 1 FROM bids bidder_link WHERE bidder_link.task_id = messages.task_id AND bidder_link.bidder_id = messages.recipient_id) AND EXISTS(SELECT 1 FROM tasks bidder_task WHERE bidder_task.id = messages.task_id AND bidder_task.user_id = messages.sender_id)) AS bidder_unread_messages');
        $statement->bind_param('iii', $user['id'], $user['id'], $user['id']);
        $statement->execute();
        $counts = $statement->get_result()->fetch_assoc();
        json_response(true, '', ['pending_bids' => (int) $counts['pending_bids'], 'bidder_unread_messages' => (int) $counts['bidder_unread_messages']]);
    }

    if ($action === 'read_bids') {
        $taskId = filter_var($_GET['task_id'] ?? null, FILTER_VALIDATE_INT);
        if (!$taskId) json_response(false, 'A valid task is required.', [], 422);
        $statement = db()->prepare('INSERT IGNORE INTO notification_reads (user_id, notification_type, reference_id) SELECT ?, \'bid\', b.id FROM bids b JOIN tasks t ON t.id = b.task_id WHERE b.task_id = ? AND t.user_id = ? AND b.status = \'Pending\'');
        $statement->bind_param('iii', $user['id'], $taskId, $user['id']);
        $statement->execute();
        json_response(true);
    }

    if ($action === 'task_messages') {
        $taskId = filter_var($_GET['task_id'] ?? null, FILTER_VALIDATE_INT);
        if (!$taskId) json_response(false, 'A valid task is required.', [], 422);
        $statement = db()->prepare('SELECT COUNT(*) AS unread_count FROM messages m JOIN tasks t ON t.id = m.task_id WHERE m.task_id = ? AND m.recipient_id = ? AND m.read_at IS NULL AND t.user_id = ?');
        $statement->bind_param('iii', $taskId, $user['id'], $user['id']);
        $statement->execute();
        $result = $statement->get_result()->fetch_assoc();
        json_response(true, '', ['unread_count' => (int) $result['unread_count']]);
    }

    json_response(false, 'Unknown notification action.', [], 400);
} catch (Throwable $error) {
    handle_api_error($error);
}