var crypto = require('crypto');
var WebSocket = require('ws');
var express = require('express');
var cors = require('cors');

var app = express();
app.use(cors());
app.use(express.json({ limit: '100mb' }));

var XFYUN_CONFIG = {
    APPID:      (process.env.XFYUN_APPID      || '').trim(),
    API_SECRET: (process.env.XFYUN_API_SECRET  || '').trim(),
    API_KEY:    (process.env.XFYUN_API_KEY     || '').trim(),
    HOST: 'ise-api.xfyun.cn',
    URI:  '/v2/open-ise'
};

function getAuthUrl() {
    var date = new Date().toUTCString();
    var signatureOrigin = 'host: ' + XFYUN_CONFIG.HOST + '\n' +
                          'date: ' + date + '\n' +
                          'GET ' + XFYUN_CONFIG.URI + ' HTTP/1.1';
    var hmac = crypto.createHmac('sha256', XFYUN_CONFIG.API_SECRET);
    var signature = hmac.update(signatureOrigin).digest('base64');
    var authOrigin = 'api_key="' + XFYUN_CONFIG.API_KEY +
                     '", algorithm="hmac-sha256", headers="host date request-line", signature="' +
                     signature + '"';
    var authorization = Buffer.from(authOrigin).toString('base64');
    return 'wss://' + XFYUN_CONFIG.HOST + XFYUN_CONFIG.URI +
           '?authorization=' + authorization +
           '&date=' + encodeURIComponent(date) +
           '&host=' + XFYUN_CONFIG.HOST;
}

// ============================================================
// 非线性评分映射：讯飞5分制 → 100分制
// ============================================================
function mapScore(raw) {
    var mapped;
    if (raw < 0.5) {
        mapped = Math.floor(Math.random() * 21) + 10;
    } else if (raw < 1.0) {
        mapped = lerp(0.5, 1.0, 30, 55, raw);
    } else if (raw < 2.0) {
        mapped = lerp(1.0, 2.0, 55, 65, raw);
    } else if (raw < 3.0) {
        mapped = lerp(2.0, 3.0, 65, 75, raw);
    } else if (raw < 3.5) {
        mapped = lerp(3.0, 3.5, 75, 82, raw);
    } else if (raw < 4.0) {
        mapped = lerp(3.5, 4.0, 82, 88, raw);
    } else if (raw < 4.5) {
        mapped = lerp(4.0, 4.5, 88, 93, raw);
    } else {
        mapped = lerp(4.5, 5.0, 93, 99, raw);
    }
    var jitter = Math.floor(Math.random() * 5) - 2;
    mapped = Math.round(mapped + jitter);
    return Math.max(0, Math.min(100, mapped));
}

function lerp(rawMin, rawMax, outMin, outMax, value) {
    var t = (value - rawMin) / (rawMax - rawMin);
    t = Math.max(0, Math.min(1, t));
    return outMin + t * (outMax - outMin);
}

// ============================================================
// 解析讯飞结果：多维度 + 音素级诊断
// ============================================================
function parseResult(resultStr) {
    var info = { rawScore: 0, accuracy: 0, fluency: 0, syllables: [] };

    // XML: total_score
    var m = resultStr.match(/total_score\s*[=:]\s*"?([\d.]+)/);
    if (!m) m = resultStr.match(/<total_score>([\d.]+)/);
    if (!m) m = resultStr.match(/total_score[^>]*?value\s*=\s*"([\d.]+)"/);
    if (m) info.rawScore = parseFloat(m[1]);

    // accuracy_score
    m = resultStr.match(/accuracy_score\s*[=:]\s*"?([\d.]+)/);
    if (!m) m = resultStr.match(/<accuracy_score>([\d.]+)/);
    if (m) info.accuracy = parseFloat(m[1]);
    else info.accuracy = info.rawScore;

    // fluency_score
    m = resultStr.match(/fluency_score\s*[=:]\s*"?([\d.]+)/);
    if (!m) m = resultStr.match(/<fluency_score>([\d.]+)/);
    if (m) info.fluency = parseFloat(m[1]);
    else info.fluency = info.rawScore;

    // 音素级 <phone content="ae" dp_message="0" .../>
    // dp_message: 0=正确, 16=漏读, 32=增读, 64=错读, 128=回读
    var phoneReg = /<phone[^>]*content="([^"]*)"[^>]*dp_message="(\d+)"[^>]*/g;
    var pm;
    while ((pm = phoneReg.exec(resultStr)) !== null) {
        info.syllables.push({ content: pm[1], dp: parseInt(pm[2]), ok: parseInt(pm[2]) === 0 });
    }

    // fallback: <syll>
    if (info.syllables.length === 0) {
        var syllReg = /<syll[^>]*content="([^"]*)"[^>]*dp_message="(\d+)"[^>]*/g;
        while ((pm = syllReg.exec(resultStr)) !== null) {
            info.syllables.push({ content: pm[1], dp: parseInt(pm[2]), ok: parseInt(pm[2]) === 0 });
        }
    }

    // JSON fallback
    if (info.rawScore === 0) {
        try {
            var obj = JSON.parse(resultStr);
            if (obj.read_word && obj.read_word.rec_paper) {
                var rp = obj.read_word.rec_paper;
                var ch = rp.read_chapter;
                if (ch) {
                    var w = ch.word && ch.word[0];
                    if (w) {
                        if (w.total_score != null) info.rawScore = w.total_score;
                        if (w.accuracy_score != null) info.accuracy = w.accuracy_score;
                        if (w.fluency_score != null) info.fluency = w.fluency_score;
                        if (w.syll) {
                            w.syll.forEach(function(s) {
                                if (s.phone) {
                                    s.phone.forEach(function(p) {
                                        info.syllables.push({
                                            content: p.content || '',
                                            dp: p.dp_message || 0,
                                            ok: (p.dp_message || 0) === 0
                                        });
                                    });
                                }
                            });
                        }
                    } else if (ch.total_score != null) {
                        info.rawScore = ch.total_score;
                    }
                } else if (rp.total_score != null) {
                    info.rawScore = rp.total_score;
                }
            }
        } catch (e) {
            var m3 = resultStr.match(/total_score[^>]*?["=:]\s*([\d.]+)/);
            if (m3) info.rawScore = parseFloat(m3[1]);
        }
    }

    if (info.accuracy === 0) info.accuracy = info.rawScore;
    if (info.fluency === 0) info.fluency = info.rawScore;

    return info;
}

// ============================================================
// 友好错误
// ============================================================
function friendlyError(code, msg) {
    var map = {
        '10110': '网络不稳定，请稍后再试',
        '10114': '录音时间太短，请重新录制',
        '10160': '请对着麦克风清晰读出单词',
        '10161': '没有检测到声音，请大声一些',
        '11200': '没有检测到语音，请重试',
        '11201': '请靠近麦克风重试',
        '10313': '评测引擎繁忙，请稍后再试',
        '48195': '音频异常，请刷新页面重试'
    };
    var s = String(code);
    if (map[s]) return map[s];
    if (msg && (msg.indexOf('no audio') >= 0 || msg.indexOf('detect no') >= 0))
        return '没有检测到声音，请对着麦克风清晰读出单词';
    return '评测出错(' + code + ')，请重试';
}

// ============================================================
// API
// ============================================================
app.post('/api/evaluate', function(req, res) {
    var t0 = Date.now();
    var audio = req.body.audio;
    var text = req.body.text;
    if (!audio || !text) return res.status(400).json({ success: false, error: '缺少参数' });

    var audioBytes = Buffer.from(audio, 'base64').length;
    console.log('[Tom] req | "' + text + '" | ' + audioBytes + 'B');

    evaluateAudio(audio, text).then(function(result) {
        console.log('[Tom] ok | raw=' + result.rawScore + ' → score=' + result.score +
                    ' acc=' + result.accuracy + ' flu=' + result.fluency +
                    ' | ' + (Date.now() - t0) + 'ms');
        res.json(result);
    }).catch(function(err) {
        console.error('[Tom] fail | ' + (Date.now() - t0) + 'ms | ' + err.message);
        res.status(500).json({ success: false, error: err.message });
    });
});

app.get('/', function(req, res) { res.send('Tom English v2 OK'); });
app.get('/health', function(req, res) { res.json({ ok: true, v: 2 }); });

var PORT = process.env.PORT || 8080;
app.listen(PORT, function() {
    console.log('[Tom] v2 port=' + PORT);
    console.log('[Tom] APPID=' + (XFYUN_CONFIG.APPID ? 'YES' : 'NO') +
                ' KEY=' + (XFYUN_CONFIG.API_KEY ? 'YES' : 'NO') +
                ' SECRET=' + (XFYUN_CONFIG.API_SECRET ? 'YES' : 'NO'));
});

// ============================================================
// 讯飞 ISE v2 WebSocket
// ============================================================
function evaluateAudio(audioBase64, text) {
    return new Promise(function(resolve, reject) {
        var finished = false;
        var timeoutTimer = null;

        function done(err, result) {
            if (finished) return;
            finished = true;
            if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = null; }
            try { ws.terminate(); } catch (e) {}
            if (err) reject(err); else resolve(result);
        }

        var ws = new WebSocket(getAuthUrl());
        var audioBuffer = Buffer.from(audioBase64, 'base64');
        var FRAME_SIZE = 1280;
        var offset = 0;
        var frameCount = 0;
        var iseText = '\uFEFF' + '[word]\n' + text;

        timeoutTimer = setTimeout(function() { done(new Error('评测超时，请重试')); }, 30000);

        ws.on('open', function() {
            sendFrame();
        });

        function sendFrame() {
            if (finished || ws.readyState !== WebSocket.OPEN) return;
            if (ws.bufferedAmount > 1048576) { setTimeout(sendFrame, 10); return; }

            var end = Math.min(offset + FRAME_SIZE, audioBuffer.length);
            var chunk = audioBuffer.slice(offset, end);
            var isFirst = (offset === 0);
            var isLast = (end >= audioBuffer.length);
            var frame;

            if (isFirst) {
                frame = {
                    common: { app_id: XFYUN_CONFIG.APPID },
                    business: {
                        sub: 'ise', ent: 'en_vip', category: 'read_word',
                        cmd: 'ssb', aus: 1, auf: 'audio/L16;rate=16000',
                        aue: 'raw', tte: 'utf-8', text: iseText,
                        ttp_skip: true, rstcd: 'utf8'
                    },
                    data: { status: 0, encoding: 'raw', data_type: 1, data: chunk.toString('base64') }
                };
            } else if (isLast) {
                frame = {
                    business: { cmd: 'auw', aus: 4 },
                    data: { status: 2, encoding: 'raw', data_type: 1, data: chunk.toString('base64') }
                };
            } else {
                frame = {
                    business: { cmd: 'auw', aus: 2 },
                    data: { status: 1, encoding: 'raw', data_type: 1, data: chunk.toString('base64') }
                };
            }

            ws.send(JSON.stringify(frame));
            offset = end;
            frameCount++;
            if (!isLast) setTimeout(sendFrame, 40);
        }

        ws.on('message', function(rawData) {
            if (finished) return;
            try {
                var resp = JSON.parse(rawData);
                if (resp.code !== 0) {
                    done(new Error(friendlyError(resp.code, resp.message)));
                    return;
                }
                if (timeoutTimer) {
                    clearTimeout(timeoutTimer);
                    timeoutTimer = setTimeout(function() { done(new Error('评测超时')); }, 30000);
                }
                if (resp.data && resp.data.status === 2) {
                    var resultStr;
                    try { resultStr = Buffer.from(resp.data.data, 'base64').toString('utf-8'); }
                    catch (e) { resultStr = resp.data.data || ''; }

                    console.log('[Tom] result(500): ' + resultStr.substring(0, 500));
                    var info = parseResult(resultStr);

                    done(null, {
                        success: true,
                        score: mapScore(info.rawScore),
                        rawScore: Math.round(info.rawScore * 10) / 10,
                        accuracy: mapScore(info.accuracy),
                        fluency: mapScore(info.fluency),
                        syllables: info.syllables
                    });
                }
            } catch (e) {
                done(new Error('解析失败'));
            }
        });

        ws.on('error', function(err) { done(new Error('网络异常，请重试')); });
        ws.on('close', function(code) { done(new Error('连接中断，请重试')); });
    });
}
