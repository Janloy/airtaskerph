<?php
declare(strict_types=1);
require_once __DIR__ . '/../config/db.php';

try {
    $user = require_role(['user', 'admin', 'superadmin']);
    $data = request_data();
    $title = clean_string($data['title'] ?? '', 180);
    $category = clean_string($data['category'] ?? '', 80);
    $location = clean_string($data['location'] ?? '', 160);
    $description = clean_string($data['description'] ?? '', 2000);
    $budget = filter_var($data['budget'] ?? null, FILTER_VALIDATE_FLOAT);
    if ($title === '' || $category === '' || $location === '' || $description === '' || $budget === false || $budget < 0) {
        json_response(false, 'Complete every field with valid values.', [], 422);
    }
    $statement = db()->prepare('INSERT INTO tasks (user_id, title, category, budget, location, description) VALUES (?, ?, ?, ?, ?, ?)');
    $statement->bind_param('issdss', $user['id'], $title, $category, $budget, $location, $description);
    $statement->execute();
    json_response(true, 'Task posted successfully.', ['task_id' => db()->insert_id]);
} catch (Throwable $error) {
    handle_api_error($error);
}
