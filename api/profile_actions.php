<?php
declare(strict_types=1);
require_once __DIR__ . '/../config/db.php';

try {
    $user = require_login();
    $data = request_data();
    $action = $_GET['action'] ?? $_POST['action'] ?? $data['action'] ?? 'get';

    if ($action === 'get') {
        $statement = db()->prepare('SELECT id, first_name, middle_initial, last_name, email, role, avatar_path FROM users WHERE id = ? LIMIT 1');
        $statement->bind_param('i', $user['id']);
        $statement->execute();
        $row = $statement->get_result()->fetch_assoc();
        if (!$row) json_response(false, 'Your account could not be found.', [], 404);
        $_SESSION['user'] = public_user($row);
        json_response(true, '', ['user' => $_SESSION['user']]);
    }

    if ($action === 'update_profile') {
        $currentPassword = (string)($data['current_password'] ?? $_POST['current_password'] ?? '');
        $statement = db()->prepare('SELECT password FROM users WHERE id = ? LIMIT 1');
        $statement->bind_param('i', $user['id']);
        $statement->execute();
        $account = $statement->get_result()->fetch_assoc();
        if (!$account || $currentPassword === '' || !password_verify($currentPassword, $account['password'])) {
            json_response(false, 'Incorrect password. Please try again.', [], 401);
        }
        $firstName = clean_string($_POST['first_name'] ?? $data['first_name'] ?? '', 80);
        $middleInitial = strtoupper(clean_string($_POST['middle_initial'] ?? $data['middle_initial'] ?? '', 1));
        $lastName = clean_string($_POST['last_name'] ?? $data['last_name'] ?? '', 80);
        if ($firstName === '' || $lastName === '') json_response(false, 'Enter your first and last name.', [], 422);
        $statement = db()->prepare('UPDATE users SET first_name = ?, middle_initial = ?, last_name = ? WHERE id = ?');
        $statement->bind_param('sssi', $firstName, $middleInitial, $lastName, $user['id']);
        $statement->execute();
        $_SESSION['user'] = array_merge($_SESSION['user'], ['first_name' => $firstName, 'middle_initial' => $middleInitial, 'last_name' => $lastName]);
        json_response(true, 'Profile updated successfully!', ['user' => $_SESSION['user']]);
    }

    if ($action === 'update_email' || $action === 'change_password') {
        $data = request_data();
        $statement = db()->prepare('SELECT email, password FROM users WHERE id = ? LIMIT 1');
        $statement->bind_param('i', $user['id']);
        $statement->execute();
        $account = $statement->get_result()->fetch_assoc();
        if (!$account || !password_verify((string)($data['current_password'] ?? ''), $account['password'])) json_response(false, 'Incorrect password. Please try again.', [], 401);

        if ($action === 'update_email') {
            $email = strtolower(clean_string($data['email'] ?? '', 190));
            if (!filter_var($email, FILTER_VALIDATE_EMAIL)) json_response(false, 'Enter a valid email address.', [], 422);
            $statement = db()->prepare('UPDATE users SET email = ? WHERE id = ?');
            $statement->bind_param('si', $email, $user['id']);
            try { $statement->execute(); } catch (mysqli_sql_exception $error) {
                if ($error->getCode() === 1062) json_response(false, 'That email is already in use.', [], 409);
                throw $error;
            }
            $_SESSION['user']['email'] = $email;
            json_response(true, 'Your email was updated.', ['user' => $_SESSION['user']]);
        }

        $newPassword = (string)($data['new_password'] ?? '');
        if (strlen($newPassword) < 8 || $newPassword !== (string)($data['confirm_password'] ?? '')) json_response(false, 'New passwords must match and be at least 8 characters.', [], 422);
        $hash = password_hash($newPassword, PASSWORD_DEFAULT);
        $statement = db()->prepare('UPDATE users SET password = ? WHERE id = ?');
        $statement->bind_param('si', $hash, $user['id']);
        $statement->execute();
        json_response(true, 'Your password was changed.');
    }

    if ($action === 'upload_avatar') {
        $file = $_FILES['avatar'] ?? null;
        if (!$file || $file['error'] !== UPLOAD_ERR_OK || $file['size'] > 3 * 1024 * 1024) json_response(false, 'Choose an image smaller than 3 MB.', [], 422);
        $image = @getimagesize($file['tmp_name']);
        $extensions = ['image/jpeg' => 'jpg', 'image/png' => 'png', 'image/webp' => 'webp', 'image/gif' => 'gif'];
        $mime = $image['mime'] ?? '';
        if (!$image || !isset($extensions[$mime])) json_response(false, 'Upload a JPG, PNG, WEBP, or GIF image.', [], 422);
        $directory = __DIR__ . '/../uploads/profiles';
        if (!is_dir($directory) && !mkdir($directory, 0755, true) && !is_dir($directory)) json_response(false, 'Profile photo storage is unavailable.', [], 500);
        $filename = bin2hex(random_bytes(16)) . '.' . $extensions[$mime];
        if (!move_uploaded_file($file['tmp_name'], $directory . '/' . $filename)) json_response(false, 'The profile photo could not be saved.', [], 500);
        $avatarPath = 'uploads/profiles/' . $filename;
        $statement = db()->prepare('UPDATE users SET avatar_path = ? WHERE id = ?');
        $statement->bind_param('si', $avatarPath, $user['id']);
        $statement->execute();
        $previous = $_SESSION['user']['avatar_path'] ?? '';
        if (str_starts_with($previous, 'uploads/profiles/')) @unlink(__DIR__ . '/../' . $previous);
        $_SESSION['user']['avatar_path'] = $avatarPath;
        json_response(true, 'Your profile picture was updated.', ['user' => $_SESSION['user']]);
    }

    json_response(false, 'Unknown profile action.', [], 400);
} catch (Throwable $error) {
    handle_api_error($error);
}
