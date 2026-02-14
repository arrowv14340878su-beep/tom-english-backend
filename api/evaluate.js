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

app.post('/api/evaluate', function(req, res) {
    var t0 = Date.now();
    var audio = req.body.audio;
    var text = req.body.text;
    if (!audio || !text) {
        return res.status(400).json({ success: false, error: 'missing audio or text' });
    }
    var audioBytes = Buffer.from(audio, 'base64').length;
    console.log('[Tom] req | "' + text + '" | ' + audioBytes + 'B');

    evaluateAudio(audio, text).then(function(result) {
        console.log('[Tom] ok | score=' + result.score + ' | ' + (Date.now() - t0) + 'ms');
        res.json(result);
    }).catch(function(err) {
        console.error('[Tom] fail | ' + (Date.now() - t0) + 'ms | ' + err.message);
        res.status(500).json({ success: false, error: err.message });
    });
});

app.get('/', function(req, res) { res.send('Tom English Backend OK'); });
app.get('/health', function(req, res) { res.json({ ok: true }); });

var PORT = process.env.PORT || 8080;
app.listen(PORT, function() {
    console.log('[Tom] port=' + PORT);
    console.log('[Tom] APPID=' + (XFYUN_CONFIG.APPID ? 'YES' : 'NO') +
                ' KEY=' + (XFYUN_CONFIG.API_KEY ? 'YES' : 'NO') +
                ' SECRET=' + (XFYUN_CONFIG.API_SECRET ? 'YES' : 'NO'));
});

// ============================================================
// 讯飞 ISE v2
//
// 参照微信小程序已验证可用的 demo 格式：
//
// 首帧: common + business(cmd=ssb, aus=1, 全部参数) + data(status=0, encoding=raw, data_type=1, data=第一段音频)
// 中间帧: business(cmd=auw, aus=2) + data(status=1, encoding=raw, data_type=1, data=音频)
// 尾帧: business(cmd=auw, aus=4) + data(status=2, encoding=raw, data_type=1, data=音频)
//
// text格式: "\uFEFF[word]\n单词"
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
            if (err) reject(err);
            else resolve(result);
        }

        var ws = new WebSocket(getAuthUrl());
        var audioBuffer = Buffer.from(audioBase64, 'base64');
        var FRAME_SIZE = 1280;
        var offset = 0;
        var frameCount = 0;

        var iseText = '\uFEFF' + '[word]\n' + text;

        console.log('[Tom] audio=' + audioBuffer.length + 'B frames=' + Math.ceil(audioBuffer.length / FRAME_SIZE));

        timeoutTimer = setTimeout(function() { done(new Error('timeout 30s')); }, 30000);

        ws.on('open', function() {
            console.log('[Tom] ws open');
            sendFrame();
        });

        function sendFrame() {
            if (finished) return;
            if (ws.readyState !== WebSocket.OPEN) return;
            if (ws.bufferedAmount > 1048576) {
                setTimeout(sendFrame, 10);
                return;
            }

            var end = Math.min(offset + FRAME_SIZE, audioBuffer.length);
            var chunk = audioBuffer.slice(offset, end);
            var isFirst = (offset === 0);
            var isLast = (end >= audioBuffer.length);
            var frame;

            if (isFirst) {
                frame = {
                    common: { app_id: XFYUN_CONFIG.APPID },
                    business: {
                        sub: 'ise',
                        ent: 'en_vip',
                        category: 'read_word',
                        cmd: 'ssb',
                        aus: 1,
                        auf: 'audio/L16;rate=16000',
                        aue: 'raw',
                        tte: 'utf-8',
                        text: iseText,
                        ttp_skip: true,
                        rstcd: 'utf8'
                    },
                    data: {
                        status: 0,
                        encoding: 'raw',
                        data_type: 1,
                        data: chunk.toString('base64')
                    }
                };
                console.log('[Tom] frame0 (ssb+audio, status=0)');
            } else if (isLast) {
                frame = {
                    business: { cmd: 'auw', aus: 4 },
                    data: {
                        status: 2,
                        encoding: 'raw',
                        data_type: 1,
                        data: chunk.toString('base64')
                    }
                };
            } else {
                frame = {
                    business: { cmd: 'auw', aus: 2 },
                    data: {
                        status: 1,
                        encoding: 'raw',
                        data_type: 1,
                        data: chunk.toString('base64')
                    }
                };
            }

            ws.send(JSON.stringify(frame));
            offset = end;
            frameCount++;

            if (isLast) {
                console.log('[Tom] last frame (aus=4, status=2), total=' + frameCount);
            } else {
                setTimeout(sendFrame, 40);
            }
        }

        ws.on('message', function(rawData) {
            if (finished) return;
            try {
                var resp = JSON.parse(rawData);

                if (resp.code !== 0) {
                    console.error('[Tom] xfyun err: code=' + resp.code + ' msg=' + resp.message);
                    done(new Error('xfyun(' + resp.code + '): ' + resp.message));
                    return;
                }

                var ds = resp.data ? resp.data.status : '?';
                console.log('[Tom] msg: code=0 status=' + ds);

                if (timeoutTimer) {
                    clearTimeout(timeoutTimer);
                    timeoutTimer = setTimeout(function() { done(new Error('timeout')); }, 30000);
                }

                if (resp.data && resp.data.status === 2) {
                    var resultStr;
                    try {
                        resultStr = Buffer.from(resp.data.data, 'base64').toString('utf-8');
                    } catch (e) {
                        resultStr = resp.data.data || '';
                    }
                    console.log('[Tom] result(300): ' + resultStr.substring(0, 300));

                    var score = extractScore(resultStr);
                    console.log('[Tom] score=' + score);
                    done(null, { success: true, score: Math.round(score) });
                }
            } catch (e) {
                done(new Error('parse err: ' + e.message));
            }
        });

        ws.on('error', function(err) {
            console.error('[Tom] ws err: ' + err.message);
            done(new Error('ws err: ' + err.message));
        });

        ws.on('close', function(code) {
            console.log('[Tom] ws close code=' + code);
            done(new Error('ws close(' + code + ')'));
        });
    });
}

function extractScore(str) {
    // XML attr: <total_score value="85.3"/>
    var m = str.match(/total_score\s+value="([\d.]+)"/);
    if (m) return parseFloat(m[1]);

    // XML tag: <total_score>85.3</total_score>
    m = str.match(/<total_score>([\d.]+)<\/total_score>/);
    if (m) return parseFloat(m[1]);

    // JSON
    try {
        var obj = JSON.parse(str);
        if (obj.read_word && obj.read_word.rec_paper) {
            var rp = obj.read_word.rec_paper;
            if (rp.read_chapter) {
                var ch = rp.read_chapter;
                if (ch.word && ch.word[0] && ch.word[0].total_score != null) {
                    return ch.word[0].total_score;
                }
                if (ch.total_score != null) return ch.total_score;
            }
            if (rp.total_score != null) return rp.total_score;
        }
    } catch (e) {}

    // Fallback regex
    m = str.match(/total_score[^>]*?["=:]\s*([\d.]+)/);
    if (m) return parseFloat(m[1]);

    return 0;
}
