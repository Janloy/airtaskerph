<?php
declare(strict_types=1);
require_once __DIR__ . '/../config/db.php';

try {
    $data = request_data();
    $action = $data['action'] ?? $_GET['action'] ?? '';
    $user = require_login();

    if ($action === 'delete_task') {
        $taskId = filter_var($data['task_id'] ?? null, FILTER_VALIDATE_INT);
        if (!$taskId) json_response(false, 'A valid task is required.', [], 422);
        $access = db()->prepare('SELECT user_id FROM tasks WHERE id = ? LIMIT 1');
        $access->bind_param('i', $taskId);
        $access->execute();
        $taskOwner = $access->get_result()->fetch_assoc();
        if (!$taskOwner || ($user['role'] === 'user' && (int) $taskOwner['user_id'] !== (int) $user['id'])) {
            json_response(false, 'You can only manage your own task postings.', [], 403);
        }
        $statement = db()->prepare('DELETE FROM tasks WHERE id = ?');
        $statement->bind_param('i', $taskId);
        $statement->execute();
        json_response(true, 'Task removed from the marketplace.');
    }

    if ($action === 'update_task') {
        $taskId = filter_var($data['task_id'] ?? null, FILTER_VALIDATE_INT);
        $title = clean_string($data['title'] ?? '', 180);
        $category = clean_string($data['category'] ?? '', 80);
        $location = clean_string($data['location'] ?? '', 160);
        $description = clean_string($data['description'] ?? '', 2000);
        $status = clean_string($data['status'] ?? '', 20);
        $budget = filter_var($data['budget'] ?? null, FILTER_VALIDATE_FLOAT);
        if (!$taskId || $title === '' || $category === '' || $location === '' || $description === '' || $budget === false || $budget < 0 || !in_array($status, ['Open', 'In Progress', 'Completed'], true)) {
            json_response(false, 'Complete every field with valid values.', [], 422);
        }
        $access = db()->prepare('SELECT user_id FROM tasks WHERE id = ? LIMIT 1');
        $access->bind_param('i', $taskId);
        $access->execute();
        $taskOwner = $access->get_result()->fetch_assoc();
        if (!$taskOwner || ($user['role'] === 'user' && (int) $taskOwner['user_id'] !== (int) $user['id'])) {
            json_response(false, 'You can only manage your own task postings.', [], 403);
        }
        $statement = db()->prepare('UPDATE tasks SET title = ?, category = ?, budget = ?, location = ?, description = ?, status = ? WHERE id = ?');
        $statement->bind_param('ssdsssi', $title, $category, $budget, $location, $description, $status, $taskId);
        $statement->execute();
        json_response(true, 'Task updated.');
    }

    if ($action === 'create_admin') {
        if ($user['role'] !== 'superadmin') {
            json_response(false, 'Only the Superadmin can create Admin accounts.', [], 403);
        }
        $firstName = clean_string($data['first_name'] ?? '', 80);
        $middleInitial = strtoupper(clean_string($data['middle_initial'] ?? '', 1));
        $lastName = clean_string($data['last_name'] ?? '', 80);
        $email = strtolower(clean_string($data['email'] ?? '', 190));
        $password = (string) ($data['password'] ?? '');
        if ($firstName === '' || $lastName === '' || !filter_var($email, FILTER_VALIDATE_EMAIL) || strlen($password) < 8) {
            json_response(false, 'Complete the form. Passwords must be at least 8 characters.', [], 422);
        }
        $hash = password_hash($password, PASSWORD_DEFAULT);
        $statement = db()->prepare('INSERT INTO users (first_name, middle_initial, last_name, email, password, role) VALUES (?, ?, ?, ?, ?, \'admin\')');
        $statement->bind_param('sssss', $firstName, $middleInitial, $lastName, $email, $hash);
        try {
            $statement->execute();
        } catch (mysqli_sql_exception $error) {
            if ($error->getCode() === 1062) json_response(false, 'That email is already registered.', [], 409);
            throw $error;
        }
        json_response(true, 'Admin account provisioned.');
    }

    json_response(false, 'Unknown admin action.', [], 400);
} catch (Throwable $error) {
    handle_api_error($error);
}
