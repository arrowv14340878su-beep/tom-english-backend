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
// 讯飞 ISE v2 — 按官方文档 + 官方 Java Demo
//
// text 格式关键点（这是 48195 的根因）：
//   英文 read_word: "\uFEFF[word]\napple"
//   英文 read_sentence: "\uFEFF[content]\nThe cat sat on the mat."
//   text 字段传 UTF-8 明文（带 BOM 头 + [word] 标签）
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

        // 关键：构造正确的评测文本格式
        // read_word 题型需要 [word] 标签包裹
        const iseText = '\uFEFF[word]\n' + text;

        console.log(`[Tom] 音频=${audioBuffer.length}B 帧数=${Math.ceil(audioBuffer.length / FRAME_SIZE)}`);
        console.log(`[Tom] 评测文本: "${iseText.replace('\uFEFF', 'BOM+')}"`);

        timeoutTimer = setTimeout(() => { done(new Error('超时(30s)')); }, 30000);

        ws.on('open', () => {
            console.log('[Tom] WS连接成功');

            // ===== 第1步：参数帧 =====
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
                    text: iseText,
                    ttp_skip: true
                },
                data: {
                    status: 0
                }
            };

            ws.send(JSON.stringify(paramFrame));
            console.log('[Tom] 参数帧已发送 (cmd=ssb)');

            // ===== 第2-4步：音频帧 =====
            const sendAudio = () => {
                if (finished) return;
                if (ws.readyState !== WebSocket.OPEN) return;
                if (ws.bufferedAmount > MAX_BUFFERED) {
                    setTimeout(sendAudio, 10);
                    return;
                }

                const end = Math.min(offset + FRAME_SIZE, audioBuffer.length);
                const chunk = audioBuffer.slice(offset, end);
                const isFirst = (offset === 0);
                const isLast  = (end >= audioBuffer.length);

                let aus;
                if (isFirst) aus = 1;
                else if (isLast) aus = 4;
                else aus = 2;

                const frame = {
                    business: {
                        cmd: 'auw',
                        aus: aus
                    },
                    data: {
                        status: isLast ? 2 : 1,
                        data: chunk.toString('base64')
                    }
                };

                ws.send(JSON.stringify(frame));
                offset = end;
                frameCount++;

                if (isFirst) console.log('[Tom] 音频首帧 (aus=1)');
                if (isLast) {
                    console.log(`[Tom] 音频尾帧 (aus=4), 共${frameCount}帧`);
                } else {
                    setTimeout(sendAudio, 40);
                }
            };

            setTimeout(sendAudio, 40);
        });

        ws.on('message', (rawData) => {
            if (finished) return;
            try {
                const resp = JSON.parse(rawData);

                if (resp.code !== 0) {
                    console.error(`[Tom] 讯飞错误: code=${resp.code} msg=${resp.message}`);
                    done(new Error(`讯飞错误(${resp.code}): ${resp.message}`));
                    return;
                }

                const ds = resp.data ? resp.data.status : '?';
                console.log(`[Tom] 消息: code=0 status=${ds}`);

                if (timeoutTimer) {
                    clearTimeout(timeoutTimer);
                    timeoutTimer = setTimeout(() => { done(new Error('超时')); }, 30000);
                }

                if (resp.data && resp.data.status === 2) {
                    let resultStr;
                    try {
                        resultStr = Buffer.from(resp.data.data, 'base64').toString('utf-8');
                    } catch (_) {
                        resultStr = resp.data.data;
                    }
                    console.log('[Tom] 结果:', resultStr.substring(0, 500));

                    let score = 0;
                    // 尝试 XML: <total_score value="85.3"/>
                    const xmlMatch = resultStr.match(/total_score\s+value="([\d.]+)"/);
                    if (xmlMatch) {
                        score = parseFloat(xmlMatch[1]);
                    } else {
                        // 尝试 JSON
                        try {
                            const obj = JSON.parse(resultStr);
                            const w = obj.read_word;
                            if (w && w.rec_paper) {
                                const ch = w.rec_paper.read_chapter;
                                if (ch && ch.word && ch.word[0]) {
                                    score = ch.word[0].total_score || 0;
                                } else if (ch && ch.total_score != null) {
                                    score = ch.total_score;
                                }
                            }
                        } catch (_) {
                            // 再尝试其他 XML 格式
                            const m2 = resultStr.match(/total_score[^>]*>([\d.]+)/);
                            if (m2) score = parseFloat(m2[1]);
                        }
                    }

                    console.log(`[Tom] 得分=${score}`);
                    done(null, { success: true, score: Math.round(score) });
                }
            } catch (e) {
                done(new Error('解析失败: ' + e.message));
            }
        });

        ws.on('error', (err) => {
            console.error('[Tom] WS Error:', err.message);
            done(new Error('WS错误: ' + err.message));
        });

        ws.on('close', (code) => {
            console.log(`[Tom] WS关闭 code=${code}`);
            done(new Error('WS关闭(' + code + ')'));
        });
    });
}
