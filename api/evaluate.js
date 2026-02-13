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
// 讯飞 WebSocket 签名鉴权
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
// API 路由
// ============================================================
app.post('/api/evaluate', async (req, res) => {
    const startTime = Date.now();
    try {
        const { audio, text } = req.body;
        if (!audio || !text) {
            return res.status(400).json({ success: false, error: '缺少 audio 或 text 参数' });
        }
        const audioBytes = Buffer.from(audio, 'base64').length;
        console.log(`[Tom] 收到请求 | 单词: "${text}" | 音频: ${audioBytes}B (${(audioBytes / 32000).toFixed(1)}s)`);

        const result = await evaluateAudio(audio, text);

        console.log(`[Tom] 完成 | 得分: ${result.score} | 耗时: ${Date.now() - startTime}ms`);
        res.json(result);
    } catch (error) {
        console.error(`[Tom] 失败 | 耗时: ${Date.now() - startTime}ms |`, error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/', (req, res) => res.send('Tom English Backend ✅'));
app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`[Tom] 服务启动 port=${PORT}`);
    console.log(`[Tom] APPID: ${XFYUN_CONFIG.APPID ? '✅' : '❌ 未配置'}`);
    console.log(`[Tom] API_KEY: ${XFYUN_CONFIG.API_KEY ? '✅' : '❌ 未配置'}`);
    console.log(`[Tom] API_SECRET: ${XFYUN_CONFIG.API_SECRET ? '✅' : '❌ 未配置'}`);
});

// ============================================================
// 讯飞语音评测核心
// ============================================================
function evaluateAudio(audioBase64, text) {
    return new Promise((resolve, reject) => {
        let finished = false;
        let timeoutTimer = null;

        // 统一出口：防重复触发 + 清理资源
        const done = (err, result) => {
            if (finished) return;
            finished = true;
            if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = null; }
            try { ws.terminate(); } catch (_) {}
            if (err) reject(err);
            else resolve(result);
        };

        // 连接讯飞
        const ws = new WebSocket(getAuthUrl());
        const audioBuffer = Buffer.from(audioBase64, 'base64');

        // 每帧 2560 bytes = 80ms @16kHz/16bit/mono，减少帧数
        const FRAME_SIZE = 2560;
        const MAX_BUFFERED = 1024 * 1024; // 1MB 缓冲上限
        let offset = 0;

        console.log(`[Tom] 音频: ${audioBuffer.length}B, 帧数: ${Math.ceil(audioBuffer.length / FRAME_SIZE)}`);

        // 30 秒总超时
        timeoutTimer = setTimeout(() => {
            done(new Error('评测超时(30s)'));
        }, 30000);

        // ---- 发送音频（带流控） ----
        ws.on('open', () => {
            console.log('[Tom] WS已连接，发送音频...');

            const sendNext = () => {
                if (finished) return;
                if (ws.readyState !== WebSocket.OPEN) return;

                // 流控
                if (ws.bufferedAmount > MAX_BUFFERED) {
                    setTimeout(sendNext, 10);
                    return;
                }

                const end = Math.min(offset + FRAME_SIZE, audioBuffer.length);
                const chunk = audioBuffer.slice(offset, end);
                const isFirst = (offset === 0);
                const isLast  = (end >= audioBuffer.length);

                const frame = {
                    data: {
                        status: isFirst ? 0 : (isLast ? 2 : 1),
                        encoding: 'raw',
                        data_type: 1,
                        data: chunk.toString('base64')
                    }
                };

                if (isFirst) {
                    frame.common = { app_id: XFYUN_CONFIG.APPID };
                    frame.business = {
                        category: 'read_word',
                        sub: 'ise',
                        ent: 'en_vip',
                        cmd: 'ssb',
                        auf: 'audio/L16;rate=16000',
                        aue: 'raw',
                        tte: 'utf-8',
                        text: Buffer.from('\uFEFF' + text).toString('base64'),
                        ttp_skip: true
                    };
                }

                ws.send(JSON.stringify(frame));
                offset = end;

                if (!isLast) {
                    setTimeout(sendNext, 20);
                } else {
                    console.log('[Tom] 音频发送完毕，等待结果...');
                }
            };

            sendNext();
        });

        // ---- 接收结果 ----
        ws.on('message', (rawData) => {
            if (finished) return;
            try {
                const resp = JSON.parse(rawData);

                if (resp.code !== 0) {
                    done(new Error(`讯飞错误(${resp.code}): ${resp.message}`));
                    return;
                }

                // 收到消息就刷新超时
                if (timeoutTimer) {
                    clearTimeout(timeoutTimer);
                    timeoutTimer = setTimeout(() => {
                        done(new Error('评测超时(等待结果30s)'));
                    }, 30000);
                }

                if (resp.data && resp.data.status === 2) {
                    const resultStr = Buffer.from(resp.data.data, 'base64').toString('utf-8');
                    console.log('[Tom] 原始结果(前300):', resultStr.substring(0, 300));

                    try {
                        const resObj = JSON.parse(resultStr);
                        let score = 0;
                        const word = resObj.read_word;
                        if (word?.rec_paper?.read_chapter?.word?.[0]?.total_score != null) {
                            score = word.rec_paper.read_chapter.word[0].total_score;
                        } else if (word?.rec_paper?.read_chapter?.total_score != null) {
                            score = word.rec_paper.read_chapter.total_score;
                        } else if (word?.rec_paper?.total_score != null) {
                            score = word.rec_paper.total_score;
                        }
                        console.log(`[Tom] 得分: ${score}`);
                        done(null, { success: true, score: Math.round(score) });
                    } catch (parseErr) {
                        done(new Error('解析评测JSON失败: ' + parseErr.message));
                    }
                }
            } catch (e) {
                done(new Error('解析WS消息失败: ' + e.message));
            }
        });

        ws.on('error', (err) => {
            console.error('[Tom] WS Error:', err.message);
            done(new Error('WebSocket错误: ' + err.message));
        });

        ws.on('close', (code, reason) => {
            console.log(`[Tom] WS关闭 code=${code} reason=${reason || ''}`);
            done(new Error(`WebSocket关闭(code=${code})`));
        });
    });
}
