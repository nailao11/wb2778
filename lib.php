<?php
/**
 * 微博邮箱注册检测 —— 核心逻辑（无网络的纯函数 + 取数 + 限速/退避）。
 *
 * 本文件只定义函数，供 check.php 引入、test.php 离线测试。
 * 直接用浏览器访问本文件不会输出任何内容。
 */

if (!defined('WB_LIB')) {
    define('WB_LIB', true);
}

/** 读取配置（可用环境变量覆盖；宝塔「Node/PHP 项目 → 环境变量」或站点配置里可设）。 */
function wb_config() {
    return array(
        'formcheckUrl'  => getenv('WEIBO_FORMCHECK_URL') ?: 'https://weibo.com/signup/v5/formcheck',
        'referer'       => getenv('WEIBO_REFERER')
            ?: 'https://www.weibo.com/signup/mobile.php?lang=zh-cn&inviteCode=&from=&appsrc=&backurl=&showlogo=',
        'userAgent'     => getenv('USER_AGENT')
            ?: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        'timeoutSec'    => (int)(getenv('CHECK_TIMEOUT') ?: 15),
        'minIntervalMs' => (float)(getenv('MIN_INTERVAL_MS') ?: 1500),
        'maxBackoffMs'  => (float)(getenv('MAX_BACKOFF_MS') ?: 30000),
        'rateMax'       => (int)(getenv('RATE_MAX') !== false ? getenv('RATE_MAX') : 120), // 每 IP 每分钟；0 关闭
    );
}

/** 输出 JSON 并结束。 */
function wb_out($arr) {
    echo json_encode($arr, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT);
    exit;
}

/** 去掉 HTML 标签、压缩空白。 */
function wb_clean_msg($s) {
    return trim(preg_replace('/\s+/u', ' ', preg_replace('/<[^>]*>/u', '', (string)$s)));
}

/** 结果的公共字段。 */
function wb_base_fields($email) {
    return array('email' => $email, 'source' => 'weibo-formcheck', 'checkedAt' => gmdate('c'));
}

/** 尽力获取客户端 IP（仅用于限速，XFF 可伪造，不作安全判断）。 */
function wb_client_ip() {
    if (!empty($_SERVER['HTTP_X_FORWARDED_FOR'])) {
        $parts = explode(',', $_SERVER['HTTP_X_FORWARDED_FOR']);
        $ip = trim($parts[0]);
        if ($ip !== '') return $ip;
    }
    return isset($_SERVER['REMOTE_ADDR']) ? $_SERVER['REMOTE_ADDR'] : 'unknown';
}

/**
 * 把微博 formcheck 的原始返回翻译成结论（纯函数，可离线测试）。
 * 判定顺序：已注册 → 验证码/频率限制 → 可注册(state=true) → 邮箱不支持 → 其它(无法确定)。
 */
function wb_interpret($http, $body, $email) {
    $base = wb_base_fields($email);
    $json = json_decode((string)$body, true);

    if ($http !== 200 || !is_array($json)) {
        return array_merge($base, array(
            'status' => 'inconclusive', 'registered' => null,
            'reason' => 'bad_response', 'message' => '微博返回了非预期内容，无法判断',
            'evidence' => array('httpStatus' => $http, 'raw' => mb_substr((string)$body, 0, 300)),
        ));
    }

    $data = isset($json['data']) ? $json['data'] : null;
    // data 必须是「对象」（关联数组）；空数组 [] 或列表都视为非预期结构。
    // 注意 PHP 的 range(0, -1) 会返回 [0, -1] 而非 []，故空数组需单独判断。
    $isList = is_array($data) && (empty($data) || array_keys($data) === range(0, count($data) - 1));
    if (!is_array($data) || $isList) {
        return array_merge($base, array(
            'status' => 'inconclusive', 'registered' => null,
            'reason' => 'unexpected_response',
            'message' => (isset($json['msg']) ? wb_clean_msg($json['msg']) : '') ?: '微博返回了非预期结构，无法判断',
            'evidence' => array('code' => isset($json['code']) ? $json['code'] : null,
                                'topMsg' => isset($json['msg']) ? wb_clean_msg($json['msg']) : null,
                                'raw' => mb_substr((string)$body, 0, 300)),
        ));
    }

    $msg   = wb_clean_msg(isset($data['msg']) ? $data['msg'] : '');
    $state = isset($data['state']) ? $data['state'] : null;
    $evidence = array('state' => $state, 'code' => isset($data['code']) ? $data['code'] : null, 'msg' => $msg);

    if (preg_match('/已注册|已被注册|已经注册/u', $msg)) {
        return array_merge($base, array('status' => 'registered', 'registered' => true, 'message' => $msg, 'evidence' => $evidence));
    }
    if (preg_match('/验证码|安全验证|滑块|频繁|请稍后|访问(受限|异常)|人机|参数限制|参数错误/u', $msg)) {
        return array_merge($base, array(
            'status' => 'inconclusive', 'registered' => null, 'reason' => 'challenge_or_rate_limit',
            'message' => $msg ?: '微博要求验证或触发了频率限制', 'evidence' => $evidence));
    }
    if ($state === true) {
        return array_merge($base, array(
            'status' => 'not_registered', 'registered' => false,
            'message' => $msg ?: '该邮箱可以注册（未注册）', 'evidence' => $evidence));
    }
    if (preg_match('/不支持|不可用|不合法|无效|格式/u', $msg)) {
        return array_merge($base, array(
            'status' => 'unsupported', 'registered' => null, 'reason' => 'email_unsupported',
            'message' => $msg ?: '该邮箱不可用/不被支持', 'evidence' => $evidence));
    }
    return array_merge($base, array(
        'status' => 'inconclusive', 'registered' => null, 'reason' => 'unknown_message',
        'message' => $msg ?: '微博返回了未知提示',
        'evidence' => array_merge($evidence, array('raw' => mb_substr((string)$body, 0, 300)))));
}

/** 向微博发起请求。返回 array('http'=>int, 'body'=>?string, 'err'=>?string)。 */
function wb_fetch($cfg, $email) {
    $url = $cfg['formcheckUrl'] . '?type=email&value=' . rawurlencode($email);
    $headers = array(
        'Referer: ' . $cfg['referer'],
        'X-Requested-With: XMLHttpRequest',
        'Accept: application/json, text/plain, */*',
        'Accept-Language: zh-CN,zh;q=0.9',
    );

    if (function_exists('curl_init')) {
        $ch = curl_init($url);
        curl_setopt_array($ch, array(
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_TIMEOUT        => $cfg['timeoutSec'],
            CURLOPT_USERAGENT      => $cfg['userAgent'],
            CURLOPT_HTTPHEADER     => $headers,
        ));
        $body = curl_exec($ch);
        $http = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $err  = ($body === false) ? curl_error($ch) : null;
        curl_close($ch);
        return array('http' => $http, 'body' => $body, 'err' => $err);
    }

    $ctx = stream_context_create(array('http' => array(
        'method'        => 'GET',
        'header'        => implode("\r\n", array_merge(array('User-Agent: ' . $cfg['userAgent']), $headers)),
        'timeout'       => $cfg['timeoutSec'],
        'ignore_errors' => true,
    )));
    $body = @file_get_contents($url, false, $ctx);
    $http = 0;
    if (isset($http_response_header)) {
        foreach ($http_response_header as $h) {
            if (preg_match('#HTTP/\S+\s+(\d+)#', $h, $m)) $http = (int)$m[1];
        }
    }
    return array('http' => $http, 'body' => $body, 'err' => ($body === false) ? 'file_get_contents failed' : null);
}

/** 状态文件路径（跨请求共享限速/退避状态）。 */
function wb_state_file() {
    return sys_get_temp_dir() . '/weibo_check_state.json';
}

/** 读取状态文件（需已持锁）。 */
function wb_read_state($fp) {
    rewind($fp);
    $raw = stream_get_contents($fp);
    $st = json_decode((string)$raw, true);
    return is_array($st) ? $st : array();
}

/** 写回状态文件（需已持锁）。 */
function wb_write_state($fp, $st) {
    ftruncate($fp, 0);
    rewind($fp);
    fwrite($fp, json_encode($st));
    fflush($fp);
}

/**
 * 入口闸门：每 IP 限速 + 全局节流（自适应退避）。
 * 命中限速返回 array('rate_limited'=>true)；否则会 sleep 到该请求应发出的时刻后返回 false。
 * 若临时目录不可写则静默跳过（宁可放行也不报错）。
 */
function wb_gate($cfg, $ip) {
    $wait = 0.0;
    $rate_limited = false;

    $fp = @fopen(wb_state_file(), 'c+');
    if ($fp && flock($fp, LOCK_EX)) {
        $st  = wb_read_state($fp);
        $now = microtime(true) * 1000;
        $win = 60000;

        if ($cfg['rateMax'] > 0) {
            $ips = (isset($st['ips']) && is_array($st['ips'])) ? $st['ips'] : array();
            $arr = (isset($ips[$ip]) && is_array($ips[$ip])) ? $ips[$ip] : array();
            $arr = array_values(array_filter($arr, function ($t) use ($now, $win) { return $now - $t < $win; }));
            if (count($arr) >= $cfg['rateMax']) {
                $rate_limited = true;
            } else {
                $arr[] = $now;
            }
            $ips[$ip] = $arr;
            // 清理过期 IP，避免状态文件无限增长
            foreach ($ips as $k => $v) {
                $v = array_values(array_filter((array)$v, function ($t) use ($now, $win) { return $now - $t < $win; }));
                if (empty($v)) { unset($ips[$k]); } else { $ips[$k] = $v; }
            }
            $st['ips'] = $ips;
        }

        if (!$rate_limited) {
            $lastAt       = isset($st['lastAt']) ? (float)$st['lastAt'] : 0.0;
            $backoffUntil = isset($st['backoffUntil']) ? (float)$st['backoffUntil'] : 0.0;
            $earliest     = max($lastAt + $cfg['minIntervalMs'], $backoffUntil, $now);
            $wait         = $earliest - $now;
            $st['lastAt'] = $earliest; // 预约本次发送时刻，后续请求依次顺延
        }

        wb_write_state($fp, $st);
        flock($fp, LOCK_UN);
    }
    if ($fp) fclose($fp);

    if ($rate_limited) return array('rate_limited' => true);

    // 在锁外 sleep，避免长时间占用 flock / PHP 进程
    $cap = $cfg['maxBackoffMs'] + $cfg['minIntervalMs'];
    $wait = min($wait, $cap);
    if ($wait > 0) usleep((int)($wait * 1000));
    return array('rate_limited' => false);
}

/** 依据结果更新退避：软失败递增指数退避，成功则清零。 */
function wb_note_result($cfg, $result) {
    static $soft = array('challenge_or_rate_limit', 'bad_response', 'unexpected_response', 'network_error', 'timeout');
    $fp = @fopen(wb_state_file(), 'c+');
    if ($fp && flock($fp, LOCK_EX)) {
        $st  = wb_read_state($fp);
        $now = microtime(true) * 1000;
        $reason = isset($result['reason']) ? $result['reason'] : null;
        if ($reason !== null && in_array($reason, $soft, true)) {
            $streak = (isset($st['streak']) ? (int)$st['streak'] : 0) + 1;
            $st['streak'] = $streak;
            $st['backoffUntil'] = $now + min($cfg['maxBackoffMs'], $cfg['minIntervalMs'] * pow(2, $streak));
        } else {
            $st['streak'] = 0;
            $st['backoffUntil'] = 0;
        }
        wb_write_state($fp, $st);
        flock($fp, LOCK_UN);
    }
    if ($fp) fclose($fp);
}
