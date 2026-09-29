<?php
declare(strict_types=1);
require_once __DIR__ . '/../config/db.php';

try {
    $user = require_login();
    $data = request_data();
    $action = $data['action'] ?? $_GET['action'] ?? '';
    $taskId = filter_var($data['task_id'] ?? $_GET['task_id'] ?? null, FILTER_VALIDATE_INT);

    if ($action === 'my_bids') {
        if (session_status() === PHP_SESSION_ACTIVE) session_write_close();
        $statement = db()->prepare('SELECT b.id, b.task_id, b.amount, b.message, b.status, b.removal_reason, b.created_at, t.user_id AS owner_id, t.title, t.category, t.location, t.status AS task_status, u.first_name, u.last_name, (SELECT COUNT(*) FROM messages m WHERE m.task_id = b.task_id AND m.recipient_id = b.bidder_id AND m.sender_id = t.user_id AND m.read_at IS NULL) AS unread_message_count FROM bids b JOIN tasks t ON t.id = b.task_id JOIN users u ON u.id = t.user_id WHERE b.bidder_id = ? ORDER BY b.created_at DESC');
        $statement->bind_param('i', $user['id']);
        $statement->execute();
        $result = $statement->get_result();
        $bids = [];
        while ($bid = $result->fetch_assoc()) {
            $bid['id'] = (int) $bid['id'];
            $bid['task_id'] = (int) $bid['task_id'];
            $bid['amount'] = (float) $bid['amount'];
            $bid['owner_id'] = (int) $bid['owner_id'];
            $bid['unread_message_count'] = (int) $bid['unread_message_count'];
            $bid['owner_name'] = trim($bid['first_name'] . ' ' . $bid['last_name']);
            unset($bid['first_name'], $bid['last_name']);
            $bids[] = $bid;
        }
        json_response(true, '', ['bids' => $bids]);
    }

    if (!$taskId) {
        json_response(false, 'A valid task is required.', [], 422);
    }

    $taskStatement = db()->prepare('SELECT id, user_id, status FROM tasks WHERE id = ? LIMIT 1');
    $taskStatement->bind_param('i', $taskId);
    $taskStatement->execute();
    $task = $taskStatement->get_result()->fetch_assoc();
    if (!$task) {
        json_response(false, 'Task not found.', [], 404);
    }

    if ($action === 'update') {
        $bidId = filter_var($data['bid_id'] ?? null, FILTER_VALIDATE_INT);
        $amount = filter_var($data['amount'] ?? null, FILTER_VALIDATE_FLOAT);
        $message = clean_string($data['message'] ?? '', 1000);
        if (!$bidId || $amount === false || $amount < 0 || $message === '') {
            json_response(false, 'Enter a valid offer and message.', [], 422);
        }
        $check = db()->prepare('SELECT b.id FROM bids b WHERE b.id = ? AND b.task_id = ? AND b.bidder_id = ? AND b.status = \'Pending\' AND ? = \'Open\' LIMIT 1');
        $check->bind_param('iiis', $bidId, $taskId, $user['id'], $task['status']);
        $check->execute();
        if (!$check->get_result()->fetch_assoc()) {
            json_response(false, 'Only your pending bid on an open task can be edited.', [], 403);
        }
        $statement = db()->prepare('UPDATE bids SET amount = ?, message = ? WHERE id = ? AND bidder_id = ?');
        $statement->bind_param('dsii', $amount, $message, $bidId, $user['id']);
        $statement->execute();
        json_response(true, 'Your bid was updated.');
    }

    if ($action === 'delete') {
        $bidId = filter_var($data['bid_id'] ?? null, FILTER_VALIDATE_INT);
        if (!$bidId) {
            json_response(false, 'A valid bid is required.', [], 422);
        }
        $check = db()->prepare('SELECT id FROM bids WHERE id = ? AND task_id = ? AND bidder_id = ? AND status = \'Pending\' AND ? = \'Open\' LIMIT 1');
        $check->bind_param('iiis', $bidId, $taskId, $user['id'], $task['status']);
        $check->execute();
        if (!$check->get_result()->fetch_assoc()) json_response(false, 'Only your pending bid on an open task can be deleted.', [], 403);
        db()->begin_transaction();
        $messages = db()->prepare('DELETE FROM messages WHERE task_id = ? AND (sender_id = ? OR recipient_id = ?)');
        $messages->bind_param('iii', $taskId, $user['id'], $user['id']);
        $messages->execute();
        $statement = db()->prepare('DELETE FROM bids WHERE id = ? AND task_id = ? AND bidder_id = ?');
        $statement->bind_param('iii', $bidId, $taskId, $user['id']);
        $statement->execute();
        if ($statement->affected_rows === 0) {
            db()->rollback();
            json_response(false, 'The bid could not be deleted.', [], 409);
        }
        db()->commit();
        json_response(true, 'Your bid was deleted.');
    }

    if ($action === 'list') {
        $isModerator = in_array($user['role'], ['admin', 'superadmin'], true);
        if ((int) $task['user_id'] === (int) $user['id']) {
            $read = db()->prepare('INSERT IGNORE INTO notification_reads (user_id, notification_type, reference_id) SELECT ?, \'bid\', b.id FROM bids b WHERE b.task_id = ? AND b.status = \'Pending\'');
            $read->bind_param('ii', $user['id'], $taskId);
            $read->execute();
        }
        if ((int) $task['user_id'] === (int) $user['id'] || $isModerator) {
            $statement = db()->prepare('SELECT b.id, b.task_id, b.bidder_id, b.amount, b.message, b.status, b.removal_reason, b.created_at, u.first_name, u.last_name, (SELECT COUNT(*) FROM messages m WHERE m.task_id = b.task_id AND m.recipient_id = ? AND m.sender_id = b.bidder_id AND m.read_at IS NULL) AS unread_message_count FROM bids b JOIN users u ON u.id = b.bidder_id WHERE b.task_id = ? ORDER BY b.created_at DESC');
            $statement->bind_param('ii', $user['id'], $taskId);
        } else {
            $statement = db()->prepare('SELECT b.id, b.task_id, b.bidder_id, b.amount, b.message, b.status, b.removal_reason, b.created_at, u.first_name, u.last_name, (SELECT COUNT(*) FROM messages m WHERE m.task_id = b.task_id AND m.recipient_id = ? AND m.sender_id = b.bidder_id AND m.read_at IS NULL) AS unread_message_count FROM bids b JOIN users u ON u.id = b.bidder_id WHERE b.task_id = ? AND (b.status <> \'Pending\' OR b.bidder_id = ?) ORDER BY b.created_at DESC');
            $statement->bind_param('iii', $user['id'], $taskId, $user['id']);
        }
        $statement->execute();
        $result = $statement->get_result();
        $bids = [];
        while ($bid = $result->fetch_assoc()) {
            $bid['id'] = (int) $bid['id'];
            $bid['task_id'] = (int) $bid['task_id'];
            $bid['bidder_id'] = (int) $bid['bidder_id'];
            $bid['amount'] = (float) $bid['amount'];
            $bid['unread_message_count'] = (int) $bid['unread_message_count'];
            $bid['bidder_name'] = trim($bid['first_name'] . ' ' . $bid['last_name']);
            unset($bid['first_name'], $bid['last_name']);
            $bids[] = $bid;
        }
        json_response(true, '', ['bids' => $bids]);
    }

    if ($action === 'place') {
        if ((int) $task['user_id'] === (int) $user['id']) {
            json_response(false, 'You cannot bid on your own task.', [], 403);
        }
        $acceptedCheck = db()->prepare('SELECT id FROM bids WHERE bidder_id = ? AND status = \'Accepted\' LIMIT 1');
        $acceptedCheck->bind_param('i', $user['id']);
        $acceptedCheck->execute();
        if ($acceptedCheck->get_result()->fetch_assoc()) {
            json_response(false, 'You already have an accepted bid. Complete that task before bidding on another task.', [], 409);
        }
        if ($task['status'] !== 'Open') {
            json_response(false, 'This task is no longer accepting bids.', [], 409);
        }
        $amount = filter_var($data['amount'] ?? null, FILTER_VALIDATE_FLOAT);
        $message = clean_string($data['message'] ?? '', 1000);
        if ($amount === false || $amount < 0 || $message === '') {
            json_response(false, 'Enter a valid offer and message.', [], 422);
        }
        $statement = db()->prepare('INSERT INTO bids (task_id, bidder_id, amount, message) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE amount = VALUES(amount), message = VALUES(message), status = \'Pending\'');
        $statement->bind_param('iids', $taskId, $user['id'], $amount, $message);
        $statement->execute();
        $resetNotification = db()->prepare('DELETE nr FROM notification_reads nr JOIN bids b ON b.id = nr.reference_id AND nr.notification_type = \'bid\' JOIN tasks t ON t.id = b.task_id WHERE b.task_id = ? AND b.bidder_id = ? AND t.user_id <> ?');
        $resetNotification->bind_param('iii', $taskId, $user['id'], $user['id']);
        $resetNotification->execute();
        json_response(true, 'Your bid has been submitted.');
    }

    if ($action === 'remove_bid') {
        $bidId = filter_var($data['bid_id'] ?? null, FILTER_VALIDATE_INT);
        if (!$bidId) json_response(false, 'A valid bid is required.', [], 422);
        if ((int) $task['user_id'] !== (int) $user['id'] && !in_array($user['role'], ['admin', 'superadmin'], true)) {
            json_response(false, 'Only the task owner or a moderator can remove a bidder.', [], 403);
        }
        $reason = clean_string($data['reason'] ?? '', 1000);
        if ($reason === '') json_response(false, 'Please provide a reason for removing the bidder.', [], 422);
        $check = db()->prepare('SELECT id FROM bids WHERE id = ? AND task_id = ? AND status IN (\'Pending\', \'Accepted\') LIMIT 1');
        $check->bind_param('ii', $bidId, $taskId);
        $check->execute();
        if (!$check->get_result()->fetch_assoc()) {
            json_response(false, 'Only pending or accepted bidders can be removed.', [], 409);
        }
        $statement = db()->prepare('UPDATE bids SET status = \'Pending\', removal_reason = ? WHERE id = ? AND task_id = ? AND status IN (\'Pending\', \'Accepted\')');
        $statement->bind_param('sii', $reason, $bidId, $taskId);
        $statement->execute();
        if ($statement->affected_rows === 0) json_response(false, 'The bidder could not be removed.', [], 409);
        json_response(true, 'The bidder was removed and the reason was saved.');
    }

    if ($action === 'accept') {
        $bidId = filter_var($data['bid_id'] ?? null, FILTER_VALIDATE_INT);
        if (!$bidId) {
            json_response(false, 'A valid bid is required.', [], 422);
        }
        if ((int) $task['user_id'] !== (int) $user['id'] && !in_array($user['role'], ['admin', 'superadmin'], true)) {
            json_response(false, 'Only the task owner or a moderator can accept a bid.', [], 403);
        }
        $bidCheck = db()->prepare('SELECT id FROM bids WHERE id = ? AND task_id = ? LIMIT 1');
        $bidCheck->bind_param('ii', $bidId, $taskId);
        $bidCheck->execute();
        if (!$bidCheck->get_result()->fetch_assoc()) {
            json_response(false, 'Bid not found for this task.', [], 404);
        }
        db()->begin_transaction();
        $statement = db()->prepare('UPDATE bids SET status = CASE WHEN id = ? THEN \'Accepted\' ELSE \'Rejected\' END WHERE task_id = ?');
        $statement->bind_param('ii', $bidId, $taskId);
        $statement->execute();
        if ($statement->affected_rows === 0) {
            db()->rollback();
            json_response(false, 'Bid not found for this task.', [], 404);
        }
        $taskUpdate = db()->prepare('UPDATE tasks SET status = \'In Progress\' WHERE id = ? AND status = \'Open\'');
        $taskUpdate->bind_param('i', $taskId);
        $taskUpdate->execute();
        db()->commit();
        json_response(true, 'Bid accepted. The task is now in progress.');
    }

    json_response(false, 'Unknown bid action.', [], 400);
} catch (Throwable $error) {
    if (db()->errno) {
        try { db()->rollback(); } catch (Throwable $ignored) {}
    }
    handle_api_error($error);
}
