<?php
declare(strict_types=1);
require_once __DIR__ . '/../config/db.php';

try {
    $status = clean_string($_GET['status'] ?? '', 30);
    $category = clean_string($_GET['category'] ?? '', 80);
    $search = clean_string($_GET['search'] ?? '', 100);
    $mine = ($_GET['mine'] ?? '') === '1';
    $viewer = current_user();
    $user = $mine ? require_login() : null;
    // Release PHP's per-session lock before the database query so polling and
    // other requests from the same signed-in browser can run concurrently.
    if (session_status() === PHP_SESSION_ACTIVE) session_write_close();
    $query = $viewer
        ? 'SELECT t.id, t.user_id, t.title, t.category, t.budget, t.location, t.description, t.status, t.created_at, u.first_name, u.last_name, EXISTS(SELECT 1 FROM bids viewer_bid WHERE viewer_bid.task_id = t.id AND viewer_bid.bidder_id = ?) AS has_bid, EXISTS(SELECT 1 FROM saved_tasks viewer_saved WHERE viewer_saved.task_id = t.id AND viewer_saved.user_id = ?) AS is_saved, (SELECT COUNT(*) FROM bids task_bid WHERE task_bid.task_id = t.id) AS bid_count, (SELECT COUNT(*) FROM messages task_message WHERE task_message.task_id = t.id AND task_message.recipient_id = ? AND task_message.read_at IS NULL) AS unread_message_count FROM tasks t JOIN users u ON u.id = t.user_id WHERE 1=1'
        : 'SELECT t.id, t.user_id, t.title, t.category, t.budget, t.location, t.description, t.status, t.created_at, u.first_name, u.last_name, 0 AS has_bid, 0 AS is_saved, (SELECT COUNT(*) FROM bids task_bid WHERE task_bid.task_id = t.id) AS bid_count, 0 AS unread_message_count FROM tasks t JOIN users u ON u.id = t.user_id WHERE 1=1';
    $types = '';
    $values = [];
    if ($viewer) {
        $types .= 'iii'; $values[] = (int) $viewer['id']; $values[] = (int) $viewer['id']; $values[] = (int) $viewer['id'];
    }
    if ($mine) {
        $query .= ' AND t.user_id = ?'; $types .= 'i'; $values[] = (int) $user['id'];
    }
    if (in_array($status, ['Open', 'In Progress', 'Completed'], true)) {
        $query .= ' AND t.status = ?'; $types .= 's'; $values[] = $status;
    }
    if ($category !== '') {
        $query .= ' AND t.category = ?'; $types .= 's'; $values[] = $category;
    }
    if ($search !== '') {
        $query .= ' AND (t.title LIKE ? OR t.description LIKE ? OR t.location LIKE ?)'; $types .= 'sss'; $term = '%' . $search . '%'; $values[] = $term; $values[] = $term; $values[] = $term;
    }
    $query .= ' ORDER BY t.created_at DESC';
    $statement = db()->prepare($query);
    if ($types !== '') {
        $statement->bind_param($types, ...$values);
    }
    $statement->execute();
    $result = $statement->get_result();
    $tasks = [];
    while ($task = $result->fetch_assoc()) {
        $task['id'] = (int) $task['id'];
        $task['user_id'] = (int) $task['user_id'];
        $task['budget'] = (float) $task['budget'];
        $task['has_bid'] = (bool) $task['has_bid'];
        $task['is_saved'] = (bool) $task['is_saved'];
        $task['bid_count'] = (int) $task['bid_count'];
        $task['unread_message_count'] = (int) $task['unread_message_count'];
        $task['owner_name'] = trim($task['first_name'] . ' ' . $task['last_name']);
        unset($task['first_name'], $task['last_name']);
        $tasks[] = $task;
    }
    json_response(true, '', ['tasks' => $tasks]);
} catch (Throwable $error) {
    handle_api_error($error);
}
