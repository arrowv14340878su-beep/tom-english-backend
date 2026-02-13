const crypto = require('crypto');
const WebSocket = require('ws');
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '100mb' }));

// ============================================================
// 讯飞配置
// ============================================================
const XFYUN_CONFIG = {
    APPID:      (process.env.XFYUN_APPID      || '').trim(),
    API_SECRET: (process.env.XFYUN_API_SECRET  || '').trim(),
    API_KEY:    (process.env.XFYUN_API_KEY     || '').trim(),
    HOST: 'ise-api.xfyun.cn',
    URI:  '/v2/open-ise'
};

// ============================================================
// 签名鉴权
// ============================================================
function getAuthUrl() {
    const date = new Date().toUTCString();
    const signatureOrigin = `host: ${XFYUN_CONFIG.HOST}\ndate: ${date}\nGET ${XFYUN_CONFIG.URI} HTTP/1.1`;
    const hmac = crypto.createHmac('sha256', XFYUN_CONFIG.API_SECRET);
    const signature = hmac.update(signatureOrigin).digest('base64');
    const authOrigin = `api_key="${XFYUN_CONFIG.API_KEY}", algorithm="hmac-sha256", headers="host date request-line", signature="${signature}"`;
    const authorization = Buffer.from(authOrigin).toString('base64');
    return `wss://${XFYUN_CONFIG.HOST}${XFYUN_CONFIG.URI}?authorization=${authorization}&date=${encodeURIComponent(date)}&host=${XFYUN_CONFIG.HOST}`;
}

// ============================================================
// 路由
// ============================================================
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
// 讯飞 ISE v2 评测
//
// 协议规则（严格遵守）：
//   首帧：{ common, business(cmd=ssb), data(status=0) }
//   中间帧：{ data(status=1) }       ← 不带 common 和 business
//   尾帧：{ data(status=2) }         ← 不带 common 和 business
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
        const FRAME_SIZE = 1280; // 40ms @16kHz/16bit — 讯飞推荐值
        const MAX_BUFFERED = 1024 * 1024;
        let offset = 0;
        let frameCount = 0;

        console.log(`[Tom] 音频=${audioBuffer.length}B 帧数=${Math.ceil(audioBuffer.length / FRAME_SIZE)}`);

        // 30s 超时
        timeoutTimer = setTimeout(() => { done(new Error('超时(30s)')); }, 30000);

        ws.on('open', () => {
            console.log('[Tom] WS连接成功');

            const sendNext = () => {
                if (finished) return;
                if (ws.readyState !== WebSocket.OPEN) return;
                if (ws.bufferedAmount > MAX_BUFFERED) {
                    setTimeout(sendNext, 10);
                    return;
                }

                const end = Math.min(offset + FRAME_SIZE, audioBuffer.length);
                const chunk = audioBuffer.slice(offset, end);
                const isFirst = (offset === 0);
                const isLast  = (end >= audioBuffer.length);

                let frame;

                if (isFirst) {
                    // ========== 首帧：common + business + data ==========
                    frame = {
                        common: {
                            app_id: XFYUN_CONFIG.APPID
                        },
                        business: {
                            category: 'read_word',
                            sub: 'ise',
                            ent: 'en_vip',
                            cmd: 'ssb',
                            auf: 'audio/L16;rate=16000',
                            aue: 'raw',
                            tte: 'utf-8',
                            text: Buffer.from('\uFEFF' + text).toString('base64'),
                            ttp_skip: true
                        },
                        data: {
                            status: 0,
                            encoding: 'raw',
                            data_type: 1,
                            data: chunk.toString('base64')
                        }
                    };
                    console.log('[Tom] 发送首帧 (cmd=ssb, status=0)');
                } else {
                    // ========== 中间帧/尾帧：只有 data ==========
                    frame = {
                        data: {
                            status: isLast ? 2 : 1,
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
                    console.log(`[Tom] 尾帧已发送 (status=2), 共${frameCount}帧, 等待结果...`);
                } else {
                    setTimeout(sendNext, 40);
                }
            };

            sendNext();
        });

        ws.on('message', (rawData) => {
            if (finished) return;
            try {
                const resp = JSON.parse(rawData);

                if (resp.code !== 0) {
                    console.error(`[Tom] 讯飞错误: code=${resp.code} msg=${resp.message} sid=${resp.sid || 'N/A'}`);
                    done(new Error(`讯飞错误(${resp.code}): ${resp.message}`));
                    return;
                }

                console.log(`[Tom] 收到消息: code=${resp.code} status=${resp.data && resp.data.status} sid=${resp.sid || ''}`);

                // 刷新超时
                if (timeoutTimer) {
                    clearTimeout(timeoutTimer);
                    timeoutTimer = setTimeout(() => { done(new Error('超时(等结果30s)')); }, 30000);
                }

                if (resp.data && resp.data.status === 2) {
                    const resultStr = Buffer.from(resp.data.data, 'base64').toString('utf-8');
                    console.log('[Tom] 结果(前500):', resultStr.substring(0, 500));

                    try {
                        const resObj = JSON.parse(resultStr);
                        let score = 0;
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
                        console.log(`[Tom] 得分=${score}`);
                        done(null, { success: true, score: Math.round(score) });
                    } catch (pe) {
                        console.error('[Tom] JSON解析失败:', pe.message);
                        done(new Error('解析结果失败'));
                    }
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
