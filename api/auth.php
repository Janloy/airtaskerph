<?php
declare(strict_types=1);
require_once __DIR__ . '/../config/db.php';

try {
    $action = $_GET['action'] ?? $_POST['action'] ?? 'session';
    $data = request_data();

    if ($action === 'session') {
        $user = current_user();
        json_response(true, '', [
            'user' => $user ? public_user($user) : null,
            'expired' => !empty($GLOBALS['auth_session_expired']),
        ]);
    }

    if ($action === 'logout') {
        destroy_auth_session();
        json_response(true, 'You have been logged out.');
    }

    if ($action === 'login') {
        $email = strtolower(clean_string($data['email'] ?? '', 190));
        $password = (string) ($data['password'] ?? '');
        if (!filter_var($email, FILTER_VALIDATE_EMAIL) || $password === '') {
            json_response(false, 'Enter a valid email and password.', [], 422);
        }

        $statement = db()->prepare('SELECT id, first_name, middle_initial, last_name, email, password, role, avatar_path FROM users WHERE email = ? LIMIT 1');
        $statement->bind_param('s', $email);
        $statement->execute();
        $user = $statement->get_result()->fetch_assoc();
        if (!$user || !password_verify($password, $user['password'])) {
            json_response(false, 'The email or password is incorrect.', [], 401);
        }
        session_regenerate_id(true);
        unset($user['password']);
        $_SESSION['user'] = public_user($user);
        $_SESSION['_last_active_at'] = time();
        refresh_auth_session_cookie();
        json_response(true, 'Welcome back, ' . $user['first_name'] . '!', ['user' => $_SESSION['user']]);
    }

    if ($action === 'register') {
        $firstName = clean_string($data['first_name'] ?? '', 80);
        $middleInitial = strtoupper(clean_string($data['middle_initial'] ?? '', 1));
        $lastName = clean_string($data['last_name'] ?? '', 80);
        $email = strtolower(clean_string($data['email'] ?? '', 190));
        $password = (string) ($data['password'] ?? '');
        if ($firstName === '' || $lastName === '' || !filter_var($email, FILTER_VALIDATE_EMAIL) || strlen($password) < 8) {
            json_response(false, 'Complete the form. Passwords must be at least 8 characters.', [], 422);
        }

        $hash = password_hash($password, PASSWORD_DEFAULT);
        $statement = db()->prepare('INSERT INTO users (first_name, middle_initial, last_name, email, password, role) VALUES (?, ?, ?, ?, ?, \'user\')');
        $statement->bind_param('sssss', $firstName, $middleInitial, $lastName, $email, $hash);
        try {
            $statement->execute();
        } catch (mysqli_sql_exception $error) {
            if ($error->getCode() === 1062) {
                json_response(false, 'That email is already registered.', [], 409);
            }
            throw $error;
        }
        json_response(true, 'Account created. You can now log in.');
    }

    json_response(false, 'Unknown authentication action.', [], 400);
} catch (Throwable $error) {
    handle_api_error($error);
}
