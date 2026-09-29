<?php
declare(strict_types=1);

const DB_HOST = '127.0.0.1';
const DB_USER = 'root';
const DB_PASS = '';
const DB_NAME = 'taskerph_db';
const AUTH_SESSION_TTL = 30 * 24 * 60 * 60;

if (session_status() !== PHP_SESSION_ACTIVE) {
    ini_set('session.gc_maxlifetime', (string) AUTH_SESSION_TTL);
    ini_set('session.gc_probability', '1');
    ini_set('session.gc_divisor', '100');
    ini_set('session.use_strict_mode', '1');
    ini_set('session.use_only_cookies', '1');
    session_set_cookie_params([
        'lifetime' => AUTH_SESSION_TTL,
        'path' => '/',
        'httponly' => true,
        'samesite' => 'Lax',
        'secure' => isset($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off',
    ]);
    session_start();
}

mysqli_report(MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT);

function db(): mysqli
{
    static $connection;
    if (!$connection) {
        $connection = new mysqli(DB_HOST, DB_USER, DB_PASS, DB_NAME);
        $connection->set_charset('utf8mb4');
    }
    return $connection;
}

function json_response(bool $success, string $message = '', array $data = [], int $status = 200): never
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(array_merge(['success' => $success, 'message' => $message], $data), JSON_UNESCAPED_SLASHES);
    exit;
}

function request_data(): array
{
    $raw = file_get_contents('php://input');
    if ($raw !== false && trim($raw) !== '') {
        $decoded = json_decode($raw, true);
        if (is_array($decoded)) {
            return $decoded;
        }
    }
    return $_POST;
}

function current_user(): ?array
{
    $user = $_SESSION['user'] ?? null;
    if (!$user) return null;

    $now = time();
    $lastActive = (int) ($_SESSION['_last_active_at'] ?? 0);
    if ($lastActive > 0 && ($now - $lastActive) >= AUTH_SESSION_TTL) {
        $GLOBALS['auth_session_expired'] = true;
        destroy_auth_session();
        return null;
    }

    // Give sessions created before the idle-timeout feature a fresh activity window.
    $_SESSION['_last_active_at'] = $now;
    refresh_auth_session_cookie();
    return $user;
}

function refresh_auth_session_cookie(): void
{
    if (headers_sent() || session_status() !== PHP_SESSION_ACTIVE) return;
    $params = session_get_cookie_params();
    setcookie(session_name(), session_id(), [
        'expires' => time() + AUTH_SESSION_TTL,
        'path' => $params['path'] ?: '/',
        'domain' => $params['domain'],
        'secure' => (bool) $params['secure'],
        'httponly' => true,
        'samesite' => $params['samesite'] ?? 'Lax',
    ]);
}

function destroy_auth_session(): void
{
    $_SESSION = [];
    if (session_status() !== PHP_SESSION_ACTIVE) return;
    if (ini_get('session.use_cookies')) {
        $params = session_get_cookie_params();
        setcookie(session_name(), '', [
            'expires' => time() - 42000,
            'path' => $params['path'] ?: '/',
            'domain' => $params['domain'],
            'secure' => (bool) $params['secure'],
            'httponly' => true,
            'samesite' => $params['samesite'] ?? 'Lax',
        ]);
    }
    session_destroy();
}

function require_login(): array
{
    $user = current_user();
    if (!$user) {
        json_response(false, 'Please log in to continue.', [
            'auth_required' => true,
            'expired' => !empty($GLOBALS['auth_session_expired']),
        ], 401);
    }
    return $user;
}

function require_role(array $roles): array
{
    $user = require_login();
    if (!in_array($user['role'], $roles, true)) {
        json_response(false, 'You do not have permission to perform this action.', [], 403);
    }
    return $user;
}

function clean_string(mixed $value, int $maxLength = 255): string
{
    $value = trim((string) $value);
    return mb_substr($value, 0, $maxLength);
}

function public_user(array $user): array
{
    return [
        'id' => (int) $user['id'],
        'first_name' => $user['first_name'],
        'middle_initial' => $user['middle_initial'] ?? '',
        'last_name' => $user['last_name'],
        'email' => $user['email'],
        'role' => $user['role'],
        'avatar_path' => $user['avatar_path'] ?? null,
    ];
}

function handle_api_error(Throwable $error): never
{
    error_log($error->getMessage());
    json_response(false, 'Something went wrong while processing your request.', [], 500);
}
