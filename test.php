<?php
/**
 * 离线单元测试（不联网）。用法： php test.php
 * 校验 wb_interpret() 对各种微博返回的判定是否正确。
 */

if (php_sapi_name() !== 'cli') {
    http_response_code(403);
    exit('CLI only');
}

require __DIR__ . '/lib.php';

$REAL = array(
    'registered'  => '{"code":"600001","data":{"id":"","state":false,"type":"err","code":"600001","action":"io","msg":"该邮箱已注册，请<a href=\"//weibo.com/login.php\" target=\"_top\">直接登录</a>","iodata":""},"msg":""}',
    'available'   => '{"code":"100000","data":{"id":"","state":true,"type":"ok","code":"100000","action":"io","msg":"","iodata":""},"msg":""}',
    'unsupported' => '{"code":"600001","data":{"id":"","state":false,"type":"err","code":"600001","action":"io","msg":"注册失败(邮箱不支持)","iodata":""},"msg":""}',
    'paramerr'    => '{"code":"100001","data":[],"msg":"参数错误！(RG020101)"}',
    'paramlimit'  => '{"code":"600001","data":{"id":"","state":true,"type":"err","code":"600001","action":"io","msg":"参数限制01","iodata":""},"msg":""}',
);

$pass = 0; $fail = 0;
function check($name, $cond, $extra = '') {
    global $pass, $fail;
    $cond ? $pass++ : $fail++;
    echo ($cond ? 'PASS' : 'FAIL') . '  ' . $name . ($extra !== '' ? '  ' . $extra : '') . "\n";
}

echo "--- wb_interpret() ---\n";

$r = wb_interpret(200, $REAL['registered'], 'a@b.com');
check('已注册 -> registered', $r['status'] === 'registered' && $r['registered'] === true, "({$r['status']})");

$r = wb_interpret(200, $REAL['available'], 'a@b.com');
check('可注册 -> not_registered', $r['status'] === 'not_registered' && $r['registered'] === false, "({$r['status']})");

$r = wb_interpret(200, $REAL['unsupported'], 'a@b.com');
check('邮箱不支持 -> unsupported', $r['status'] === 'unsupported', "({$r['status']})");

$r = wb_interpret(200, $REAL['paramerr'], 'a@b.com');
check('参数错误(data为空数组) -> inconclusive', $r['status'] === 'inconclusive', "({$r['status']}/{$r['reason']})");

$r = wb_interpret(200, $REAL['paramlimit'], 'a@b.com');
check('参数限制+state:true -> inconclusive', $r['status'] === 'inconclusive' && $r['registered'] === null, "({$r['status']}/{$r['reason']})");

$r = wb_interpret(200, 'not-json', 'a@b.com');
check('非 JSON -> inconclusive', $r['status'] === 'inconclusive' && $r['reason'] === 'bad_response', "({$r['reason']})");

$r = wb_interpret(503, '{}', 'a@b.com');
check('HTTP 503 -> inconclusive', $r['status'] === 'inconclusive', "({$r['status']})");

echo "\n$pass passed, $fail failed.\n";
exit($fail === 0 ? 0 : 1);
