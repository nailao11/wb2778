<?php
/**
 * 微博邮箱注册检测 —— 检测接口。
 * 用法： GET check.php?email=name@example.com
 * 部署： 与 index.html、lib.php 一起放到网站根目录（宝塔 / PHP 虚拟主机）。
 */

define('WB_APP', true);
require __DIR__ . '/lib.php';

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

$cfg   = wb_config();
$email = isset($_GET['email']) ? trim($_GET['email']) : '';

if ($email === '') {
    http_response_code(400);
    wb_out(array('status' => 'error', 'error' => 'missing_email', 'message' => '缺少 email 参数'));
}

if (!preg_match('/^[^\s@]+@[^\s@]+\.[^\s@]+$/u', $email)) {
    wb_out(array_merge(wb_base_fields($email), array(
        'status' => 'invalid_email', 'registered' => null,
        'reason' => 'client_format_check', 'message' => '邮箱格式不正确',
        'evidence' => new stdClass(),
    )));
}

// 每 IP 限速 + 全局自适应节流
$gate = wb_gate($cfg, wb_client_ip());
if (!empty($gate['rate_limited'])) {
    http_response_code(429);
    wb_out(array('status' => 'error', 'error' => 'rate_limited', 'message' => '请求过于频繁，请稍后再试'));
}

$f = wb_fetch($cfg, $email);

if ($f['err'] !== null || $f['body'] === null || $f['body'] === false) {
    $result = array_merge(wb_base_fields($email), array(
        'status' => 'inconclusive', 'registered' => null,
        'reason' => 'network_error', 'message' => '无法连接微博，无法判断',
        'error' => $f['err'], 'evidence' => new stdClass(),
    ));
} else {
    $result = wb_interpret($f['http'], $f['body'], $email);
}

wb_note_result($cfg, $result);
wb_out($result);
