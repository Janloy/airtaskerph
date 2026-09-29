<?php
declare(strict_types=1);
require_once __DIR__ . '/../config/db.php';

try {
    $user = require_login();
    $data = request_data();
    $action = $data['action'] ?? $_GET['action'] ?? '';
    $taskId = filter_var($data['task_id'] ?? $_GET['task_id'] ?? null, FILTER_VALIDATE_INT);
    $otherUserId = filter_var($data['other_user_id'] ?? $_GET['other_user_id'] ?? null, FILTER_VALIDATE_INT);
    if (!$taskId || !$otherUserId || (int) $otherUserId === (int) $user['id']) {
        json_response(false, 'A valid task and conversation user are required.', [], 422);
    }

    $access = db()->prepare('SELECT t.user_id AS owner_id, EXISTS(SELECT 1 FROM bids WHERE task_id = t.id AND bidder_id = ?) AS current_is_bidder, EXISTS(SELECT 1 FROM bids WHERE task_id = t.id AND bidder_id = ?) AS other_is_bidder FROM tasks t WHERE t.id = ? LIMIT 1');
    $access->bind_param('iii', $user['id'], $otherUserId, $taskId);
    $access->execute();
    $taskAccess = $access->get_result()->fetch_assoc();
    $isModerator = in_array($user['role'], ['admin', 'superadmin'], true);
    $isOwner = $taskAccess && (int) $taskAccess['owner_id'] === (int) $user['id'];
    $isBidder = $taskAccess && (int) $taskAccess['current_is_bidder'] === 1;
    $otherIsOwner = $taskAccess && (int) $taskAccess['owner_id'] === (int) $otherUserId;
    $otherIsBidder = $taskAccess && (int) $taskAccess['other_is_bidder'] === 1;
    if (!$taskAccess || ((!$isOwner || !$otherIsBidder) && (!$isBidder || !$otherIsOwner) && !$isModerator)) {
        json_response(false, 'You can only message users connected to this task.', [], 403);
    }

    if ($action === 'list') {
        $read = db()->prepare('UPDATE messages SET read_at = CURRENT_TIMESTAMP WHERE task_id = ? AND sender_id = ? AND recipient_id = ? AND read_at IS NULL');
        $read->bind_param('iii', $taskId, $otherUserId, $user['id']);
        $read->execute();
        $statement = db()->prepare('SELECT m.id, m.sender_id, m.recipient_id, m.body, m.read_at, m.created_at, u.first_name, u.last_name FROM messages m JOIN users u ON u.id = m.sender_id WHERE m.task_id = ? AND ((m.sender_id = ? AND m.recipient_id = ?) OR (m.sender_id = ? AND m.recipient_id = ?)) ORDER BY m.created_at ASC');
        $statement->bind_param('iiiii', $taskId, $user['id'], $otherUserId, $otherUserId, $user['id']);
        $statement->execute();
        $result = $statement->get_result();
        $messages = [];
        while ($message = $result->fetch_assoc()) {
            $message['id'] = (int) $message['id'];
            $message['sender_id'] = (int) $message['sender_id'];
            $message['recipient_id'] = (int) $message['recipient_id'];
            $message['sender_name'] = trim($message['first_name'] . ' ' . $message['last_name']);
            unset($message['first_name'], $message['last_name']);
            $messages[] = $message;
        }
        json_response(true, '', ['messages' => $messages]);
    }

    if ($action === 'send') {
        $body = clean_string($data['body'] ?? '', 2000);
        if ($body === '') json_response(false, 'Message cannot be empty.', [], 422);
        $statement = db()->prepare('INSERT INTO messages (task_id, sender_id, recipient_id, body) VALUES (?, ?, ?, ?)');
        $statement->bind_param('iiis', $taskId, $user['id'], $otherUserId, $body);
        $statement->execute();
        json_response(true, 'Message sent.');
    }

    json_response(false, 'Unknown message action.', [], 400);
} catch (Throwable $error) {
    handle_api_error($error);
}