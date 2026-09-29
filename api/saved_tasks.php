<?php
declare(strict_types=1);
require_once __DIR__ . '/../config/db.php';

try {
    $user = require_login();
    $data = request_data();
    $action = $_GET['action'] ?? $data['action'] ?? 'list';

    if ($action === 'list') {
        if (session_status() === PHP_SESSION_ACTIVE) session_write_close();
        $statement = db()->prepare('SELECT t.id, t.user_id, t.title, t.category, t.budget, t.location, t.description, t.status, t.created_at, u.first_name, u.last_name, s.saved_at, EXISTS(SELECT 1 FROM bids viewer_bid WHERE viewer_bid.task_id = t.id AND viewer_bid.bidder_id = ?) AS has_bid, 1 AS is_saved, (SELECT COUNT(*) FROM bids task_bid WHERE task_bid.task_id = t.id) AS bid_count, (SELECT COUNT(*) FROM messages task_message WHERE task_message.task_id = t.id AND task_message.recipient_id = ? AND task_message.read_at IS NULL) AS unread_message_count FROM saved_tasks s JOIN tasks t ON t.id = s.task_id JOIN users u ON u.id = t.user_id WHERE s.user_id = ? AND t.user_id <> ? ORDER BY s.saved_at DESC');
        $statement->bind_param('iiii', $user['id'], $user['id'], $user['id'], $user['id']);
        $statement->execute();
        $result = $statement->get_result();
        $tasks = [];
        while ($task = $result->fetch_assoc()) {
            $task['id'] = (int) $task['id'];
            $task['user_id'] = (int) $task['user_id'];
            $task['budget'] = (float) $task['budget'];
            $task['has_bid'] = (bool) $task['has_bid'];
            $task['is_saved'] = true;
            $task['bid_count'] = (int) $task['bid_count'];
            $task['unread_message_count'] = (int) $task['unread_message_count'];
            $task['owner_name'] = trim($task['first_name'] . ' ' . $task['last_name']);
            unset($task['first_name'], $task['last_name']);
            $tasks[] = $task;
        }
        json_response(true, '', ['tasks' => $tasks, 'count' => count($tasks)]);
    }

    if ($action === 'toggle') {
        $taskId = filter_var($data['task_id'] ?? null, FILTER_VALIDATE_INT);
        $saved = filter_var($data['saved'] ?? null, FILTER_VALIDATE_BOOLEAN, FILTER_NULL_ON_FAILURE);
        if (!$taskId || $saved === null) json_response(false, 'Choose a valid task and bookmark action.', [], 422);

        $statement = db()->prepare('SELECT user_id FROM tasks WHERE id = ? LIMIT 1');
        $statement->bind_param('i', $taskId);
        $statement->execute();
        $task = $statement->get_result()->fetch_assoc();
        if (!$task) json_response(false, 'Task not found.', [], 404);
        if ((int) $task['user_id'] === (int) $user['id']) json_response(false, 'You cannot save your own task.', [], 403);

        if ($saved) {
            $statement = db()->prepare('INSERT IGNORE INTO saved_tasks (user_id, task_id) VALUES (?, ?)');
            $statement->bind_param('ii', $user['id'], $taskId);
        } else {
            $statement = db()->prepare('DELETE FROM saved_tasks WHERE user_id = ? AND task_id = ?');
            $statement->bind_param('ii', $user['id'], $taskId);
        }
        $statement->execute();

        $statement = db()->prepare('SELECT COUNT(*) AS saved_count FROM saved_tasks WHERE user_id = ?');
        $statement->bind_param('i', $user['id']);
        $statement->execute();
        $count = (int) $statement->get_result()->fetch_assoc()['saved_count'];
        json_response(true, '', ['saved' => $saved, 'count' => $count, 'task_id' => (int) $taskId]);
    }

    json_response(false, 'Unknown saved tasks action.', [], 400);
} catch (Throwable $error) {
    handle_api_error($error);
}
