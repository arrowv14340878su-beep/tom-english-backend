const crypto = require('crypto');
const WebSocket = require('ws');
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '100mb' }));

const XFYUN_CONFIG = {
    APPID:      (process.env.XFYUN_APPID      || '').trim(),
    API_SECRET: (process.env.XFYUN_API_SECRET  || '').trim(),
    API_KEY:    (process.env.XFYUN_API_KEY     || '').trim(),
    HOST: 'ise-api.xfyun.cn',
    URI:  '/v2/open-ise'
};

function getAuthUrl() {
    const date = new Date().toUTCString();
    const signatureOrigin = `host: ${XFYUN_CONFIG.HOST}\ndate: ${date}\nGET ${XFYUN_CONFIG.URI} HTTP/1.1`;
    const hmac = crypto.createHmac('sha256', XFYUN_CONFIG.API_SECRET);
    const signature = hmac.update(signatureOrigin).digest('base64');
    const authOrigin = `api_key="${XFYUN_CONFIG.API_KEY}", algorithm="hmac-sha256", headers="host date request-line", signature="${signature}"`;
    const authorization = Buffer.from(authOrigin).toString('base64');
    return `wss://${XFYUN_CONFIG.HOST}${XFYUN_CONFIG.URI}?authorization=${authorization}&date=${encodeURIComponent(date)}&host=${XFYUN_CONFIG.HOST}`;
}

app.post('/api/evaluate', async (req, res) => {
    const t0 = Date.now();
    try {
        const { audio, text } = req.body;
        if (!audio || !text) {
            return res.status(400).json({ success: false, error: '缺少 audio 或 text' });
        }
        const audioBytes = Buffer.from(audio, 'base64').length;
        console.log(`[Tom] 请求 | "${text}" | ${audioBytes}B (${(audioBytes / 32000).toFixed(1)}s)`);
        const result = await evaluateAudio(audio, text);
        console.log(`[Tom] 完成 | 得分=${result.score} | ${Date.now() - t0}ms`);
        res.json(result);
    } catch (err) {
        console.error(`[Tom] 失败 | ${Date.now() - t0}ms |`, err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/', (req, res) => res.send('Tom English Backend ✅'));
app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`[Tom] port=${PORT}`);
    console.log(`[Tom] APPID=${XFYUN_CONFIG.APPID ? '✅' : '❌'} KEY=${XFYUN_CONFIG.API_KEY ? '✅' : '❌'} SECRET=${XFYUN_CONFIG.API_SECRET ? '✅' : '❌'}`);
});

// ============================================================
// 讯飞 ISE v2 — 严格按照官方文档示例
//
// 第1步 参数帧:
//   { common: {app_id}, business: {cmd:"ssb", ...全部参数}, data: {status:0} }
//   注意：data 里只有 status，没有 data/encoding/data_type
//
// 第2步 音频首帧:
//   { business: {cmd:"auw", aus:1}, data: {status:1, data:"base64音频"} }
//
// 第3步 音频中间帧:
//   { business: {cmd:"auw", aus:2}, data: {status:1, data:"base64音频"} }
//
// 第4步 音频尾帧:
//   { business: {cmd:"auw", aus:4}, data: {status:2, data:"base64音频"} }
// ============================================================
function evaluateAudio(audioBase64, text) {
    return new Promise((resolve, reject) => {
        let finished = false;
        let timeoutTimer = null;

        const done = (err, result) => {
            if (finished) return;
            finished = true;
            if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = null; }
            try { ws.terminate(); } catch (_) {}
            if (err) reject(err);
            else resolve(result);
        };

        const ws = new WebSocket(getAuthUrl());
        const audioBuffer = Buffer.from(audioBase64, 'base64');
        const FRAME_SIZE = 1280;
        const MAX_BUFFERED = 1024 * 1024;
        let offset = 0;
        let frameCount = 0;

        console.log(`[Tom] 音频=${audioBuffer.length}B 帧数=${Math.ceil(audioBuffer.length / FRAME_SIZE)}`);

        timeoutTimer = setTimeout(() => { done(new Error('超时(30s)')); }, 30000);

        ws.on('open', () => {
            console.log('[Tom] WS连接成功');

            // ===== 第1步：参数帧 (cmd=ssb) =====
            // 严格按官方示例：data 只有 {status: 0}，不含 data 字段
            const paramFrame = {
                common: {
                    app_id: XFYUN_CONFIG.APPID
                },
                business: {
                    sub: 'ise',
                    ent: 'en_vip',
                    category: 'read_word',
                    cmd: 'ssb',
                    auf: 'audio/L16;rate=16000',
                    aue: 'raw',
                    tte: 'utf-8',
                    text: '\uFEFF' + text,
                    ttp_skip: true
                },
                data: {
                    status: 0
                }
            };

            ws.send(JSON.stringify(paramFrame));
            console.log('[Tom] 参数帧已发送 (cmd=ssb, status=0)');

            // ===== 第2-4步：音频帧 =====
            const sendAudioFrame = () => {
                if (finished) return;
                if (ws.readyState !== WebSocket.OPEN) return;
                if (ws.bufferedAmount > MAX_BUFFERED) {
                    setTimeout(sendAudioFrame, 10);
                    return;
                }

                const end = Math.min(offset + FRAME_SIZE, audioBuffer.length);
                const chunk = audioBuffer.slice(offset, end);
                const isFirstAudio = (offset === 0);
                const isLastAudio  = (end >= audioBuffer.length);

                // aus: 1=首帧, 2=中间帧, 4=尾帧
                let aus;
                if (isFirstAudio) aus = 1;
                else if (isLastAudio) aus = 4;
                else aus = 2;

                const audioFrame = {
                    business: {
                        cmd: 'auw',
                        aus: aus
                    },
                    data: {
                        status: isLastAudio ? 2 : 1,
                        data: chunk.toString('base64')
                    }
                };

                ws.send(JSON.stringify(audioFrame));
                offset = end;
                frameCount++;

                if (isFirstAudio) {
                    console.log('[Tom] 音频首帧 (aus=1, status=1)');
                }
                if (isLastAudio) {
                    console.log(`[Tom] 音频尾帧 (aus=4, status=2), 共${frameCount}帧`);
                } else {
                    setTimeout(sendAudioFrame, 40);
                }
            };

            // 参数帧发完等40ms再发音频
            setTimeout(sendAudioFrame, 40);
        });

        ws.on('message', (rawData) => {
            if (finished) return;
            try {
                const resp = JSON.parse(rawData);

                if (resp.code !== 0) {
                    console.error(`[Tom] 讯飞错误: code=${resp.code} msg=${resp.message} sid=${resp.sid || ''}`);
                    done(new Error(`讯飞错误(${resp.code}): ${resp.message}`));
                    return;
                }

                const ds = resp.data ? resp.data.status : '?';
                console.log(`[Tom] 消息: code=0 data.status=${ds} sid=${resp.sid || ''}`);

                if (timeoutTimer) {
                    clearTimeout(timeoutTimer);
                    timeoutTimer = setTimeout(() => { done(new Error('超时(等结果30s)')); }, 30000);
                }

                if (resp.data && resp.data.status === 2) {
                    const raw = resp.data.data;
                    let resultStr;

                    // 尝试 base64 解码，如果失败则直接用原文
                    try {
                        resultStr = Buffer.from(raw, 'base64').toString('utf-8');
                    } catch (_) {
                        resultStr = raw;
                    }
                    console.log('[Tom] 结果(前500):', resultStr.substring(0, 500));

                    // 结果可能是 XML 或 JSON
                    let score = 0;
                    try {
                        // 尝试 JSON 解析
                        const resObj = JSON.parse(resultStr);
                        const w = resObj.read_word;
                        if (w && w.rec_paper && w.rec_paper.read_chapter) {
                            const ch = w.rec_paper.read_chapter;
                            if (ch.word && ch.word[0] && ch.word[0].total_score != null) {
                                score = ch.word[0].total_score;
                            } else if (ch.total_score != null) {
                                score = ch.total_score;
                            }
                        } else if (w && w.rec_paper && w.rec_paper.total_score != null) {
                            score = w.rec_paper.total_score;
                        }
                    } catch (_) {
                        // 可能是 XML 格式，尝试正则提取 total_score
                        const match = resultStr.match(/total_score\s*[=:]["']?([\d.]+)/);
                        if (match) {
                            score = parseFloat(match[1]);
                        } else {
                            console.log('[Tom] 无法从结果中提取分数');
                        }
                    }

                    console.log(`[Tom] 得分=${score}`);
                    done(null, { success: true, score: Math.round(score) });
                }
            } catch (e) {
                done(new Error('解析WS消息失败: ' + e.message));
            }
        });

        ws.on('error', (err) => {
            console.error('[Tom] WS Error:', err.message);
            done(new Error('WS错误: ' + err.message));
        });

        ws.on('close', (code, reason) => {
            console.log(`[Tom] WS关闭 code=${code}`);
            done(new Error('WS关闭(' + code + ')'));
        });
    });
}
