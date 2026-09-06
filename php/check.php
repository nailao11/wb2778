<?php
/**
 * 微博邮箱注册检测 — PHP 后端（适用于 PHP 虚拟主机 / 宝塔面板）
 * Weibo email registration checker — PHP backend for shared hosting / BaoTa.
 *
 * 用法 Usage:  GET check.php?email=someone@163.com
 * 依赖 Deps :  PHP 7+ 且启用 curl 扩展（几乎所有主机默认开启）；
 *             若无 curl，会自动回退到 allow_url_fopen。
 *
 * 与 Node 版判定逻辑完全一致：调用微博注册页自身的校验接口
 *   GET https://weibo.com/signup/v5/formcheck?type=email&value=<email>
 * 关键：必须带 weibo.com 的 Referer（浏览器纯静态页无法伪造，故需要后端）。
 *
 * 仅供个人学习与已授权范围内的安全测试。
 */

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
// Same-origin frontend needs no CORS. Uncomment to allow other origins:
// header('Access-Control-Allow-Origin: *');

$FORMCHECK = getenv('WEIBO_FORMCHECK_URL') ?: 'https://weibo.com/signup/v5/formcheck';
$REFERER   = getenv('WEIBO_REFERER')
    ?: 'https://www.weibo.com/signup/mobile.php?lang=zh-cn&inviteCode=&from=&appsrc=&backurl=&showlogo=';
$UA = getenv('USER_AGENT')
    ?: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
$TIMEOUT = (int)(getenv('CHECK_TIMEOUT') ?: 15);       // seconds
$MIN_INTERVAL_MS = (int)(getenv('MIN_INTERVAL_MS') ?: 1000);

function out($arr) {
    echo json_encode($arr, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT);
    exit;
}
function base_fields($email) {
    return array('email' => $email, 'source' => 'weibo-formcheck', 'checkedAt' => gmdate('c'));
}
function strip_html_ws($s) {
    return trim(preg_replace('/\s+/u', ' ', preg_replace('/<[^>]*>/u', '', (string)$s)));
}

$email = isset($_GET['email']) ? trim($_GET['email']) : '';

if ($email === '') {
    http_response_code(400);
    out(array('status' => 'error', 'error' => 'missing_email', 'message' => '缺少 email 参数'));
}
if (!preg_match('/^[^\s@]+@[^\s@]+\.[^\s@]+$/u', $email)) {
    out(array_merge(base_fields($email), array(
        'status' => 'invalid_email', 'registered' => null,
        'reason' => 'client_format_check', 'message' => '邮箱格式不正确',
        'evidence' => new stdClass(),
    )));
}

// --- polite min-interval throttle (best-effort, file lock) -----------------
$lockfile = sys_get_temp_dir() . '/weibo_check_last.lock';
$fp = @fopen($lockfile, 'c+');
if ($fp) {
    if (flock($fp, LOCK_EX)) {
        $last = (float)stream_get_contents($fp);
        $now  = microtime(true) * 1000;
        $wait = $MIN_INTERVAL_MS - ($now - $last);
        if ($wait > 0 && $wait < 10000) usleep((int)($wait * 1000));
        ftruncate($fp, 0);
        rewind($fp);
        fwrite($fp, (string)(microtime(true) * 1000));
        fflush($fp);
        flock($fp, LOCK_UN);
    }
    fclose($fp);
}

// --- request Weibo's formcheck endpoint ------------------------------------
$url = $FORMCHECK . '?type=email&value=' . rawurlencode($email);
$headers = array(
    'Referer: ' . $REFERER,
    'X-Requested-With: XMLHttpRequest',
    'Accept: application/json, text/plain, */*',
    'Accept-Language: zh-CN,zh;q=0.9',
);

$body = null; $http = 0; $err = null;

if (function_exists('curl_init')) {
    $ch = curl_init($url);
    curl_setopt_array($ch, array(
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_TIMEOUT        => $TIMEOUT,
        CURLOPT_USERAGENT      => $UA,
        CURLOPT_HTTPHEADER     => $headers,
    ));
    $body = curl_exec($ch);
    $http = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
    if ($body === false) $err = curl_error($ch);
    curl_close($ch);
} else {
    // Fallback when curl is unavailable (needs allow_url_fopen=On).
    $ctx = stream_context_create(array('http' => array(
        'method'        => 'GET',
        'header'        => implode("\r\n", array_merge(array('User-Agent: ' . $UA), $headers)),
        'timeout'       => $TIMEOUT,
        'ignore_errors' => true,
    )));
    $body = @file_get_contents($url, false, $ctx);
    if (isset($http_response_header)) {
        foreach ($http_response_header as $h) {
            if (preg_match('#HTTP/\S+\s+(\d+)#', $h, $m)) $http = (int)$m[1];
        }
    }
    if ($body === false) $err = 'file_get_contents failed (需要 curl 扩展或 allow_url_fopen)';
}

if ($err !== null || $body === null || $body === false) {
    out(array_merge(base_fields($email), array(
        'status' => 'inconclusive', 'registered' => null,
        'reason' => 'network_error', 'message' => '无法连接微博，无法判断',
        'error' => $err, 'evidence' => new stdClass(),
    )));
}

$json = json_decode($body, true);

if ($http !== 200 || !is_array($json)) {
    out(array_merge(base_fields($email), array(
        'status' => 'inconclusive', 'registered' => null,
        'reason' => 'bad_response', 'message' => '微博返回了非预期内容，无法判断',
        'evidence' => array('httpStatus' => $http, 'raw' => mb_substr((string)$body, 0, 300)),
    )));
}

$data = isset($json['data']) ? $json['data'] : null;
$isList = is_array($data) && (array_keys($data) === range(0, count($data) - 1)); // e.g. data:[]
if (!is_array($data) || $isList) {
    out(array_merge(base_fields($email), array(
        'status' => 'inconclusive', 'registered' => null,
        'reason' => 'unexpected_response',
        'message' => (isset($json['msg']) ? strip_html_ws($json['msg']) : '') ?: '微博返回结构异常',
        'evidence' => array('code' => isset($json['code']) ? $json['code'] : null,
                            'raw' => mb_substr((string)$body, 0, 300)),
    )));
}

$msg   = strip_html_ws(isset($data['msg']) ? $data['msg'] : '');
$state = isset($data['state']) ? $data['state'] : null;
$evidence = array('state' => $state, 'code' => isset($data['code']) ? $data['code'] : null, 'msg' => $msg);

// Order matters (same as Node): registered → challenge → available → unsupported → unknown.
if (preg_match('/已注册|已被注册|已经注册/u', $msg)) {
    out(array_merge(base_fields($email), array(
        'status' => 'registered', 'registered' => true, 'message' => $msg, 'evidence' => $evidence)));
}
// Captcha / rate-limit / 参数限制 — even if state:true. Do not guess.
if (preg_match('/验证码|安全验证|滑块|频繁|请稍后|访问(受限|异常)|人机|参数限制|参数错误/u', $msg)) {
    out(array_merge(base_fields($email), array(
        'status' => 'inconclusive', 'registered' => null, 'reason' => 'challenge_or_rate_limit',
        'message' => $msg ?: '微博要求验证或触发了频率限制', 'evidence' => $evidence)));
}
if ($state === true) {
    out(array_merge(base_fields($email), array(
        'status' => 'not_registered', 'registered' => false,
        'message' => $msg ?: '该邮箱可以注册（未注册）', 'evidence' => $evidence)));
}
if (preg_match('/不支持|不可用|不合法|无效|格式/u', $msg)) {
    out(array_merge(base_fields($email), array(
        'status' => 'unsupported', 'registered' => null, 'reason' => 'email_unsupported',
        'message' => $msg ?: '该邮箱不可用/不被支持', 'evidence' => $evidence)));
}
out(array_merge(base_fields($email), array(
    'status' => 'inconclusive', 'registered' => null, 'reason' => 'unknown_message',
    'message' => $msg ?: '微博返回了未知提示',
    'evidence' => array_merge($evidence, array('raw' => mb_substr((string)$body, 0, 300))),
)));
