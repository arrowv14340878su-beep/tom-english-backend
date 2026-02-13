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

        // ====== 准备 WS & 音频 ======
        const ws = new WebSocket(getAuthUrl());
        const audioBuffer = Buffer.from(audioBase64, 'base64');

        if (audioBuffer.length < 3200) return done(new Error('录音太短'));

        const FRAME_SIZE = 1280;   // 每帧约 40ms
        const MAX_BUFFERED = 1024 * 1024;
        let offset = 0;
        let frameCount = 0;

        // ====== text 格式: BOM + [word] ======
        const iseText = '\uFEFF[word]\n' + text.trim();
        const iseTextBase64 = Buffer.from(iseText, 'utf-8').toString('base64');

        timeoutTimer = setTimeout(() => { done(new Error('超时(30s)')); }, 30000);

        ws.on('open', () => {
            console.log('[Tom] WS连接成功');

            // ====== 第1帧: 参数帧 ======
            const paramFrame = {
                common: { app_id: XFYUN_CONFIG.APPID },
                business: {
                    sub: 'ise',
                    ent: 'en_vip',
                    category: 'read_word',
                    cmd: 'ssb',
                    auf: 'audio/L16;rate=16000',
                    aue: 'raw',
                    tte: 'utf-8',
                    text: iseTextBase64,
                    ttp_skip: true
                },
                data: { status: 0 }
            };
            ws.send(JSON.stringify(paramFrame));
            console.log('[Tom] 参数帧已发送');

            // ====== 第2-4步: 音频帧 ======
            const sendAudio = () => {
                if (finished) return;
                if (ws.readyState !== WebSocket.OPEN) return;
                if (ws.bufferedAmount > MAX_BUFFERED) {
                    setTimeout(sendAudio, 10);
                    return;
                }

                const end = Math.min(offset + FRAME_SIZE, audioBuffer.length);
                const chunk = audioBuffer.slice(offset, end);

                const isFirst = offset === 0;
                const isLast  = end >= audioBuffer.length;

                const frame = {
                    business: { cmd: 'auw', aus: isFirst ? 1 : (isLast ? 4 : 2) },
                    data: { status: isLast ? 2 : 1, data: chunk.toString('base64') }
                };

                ws.send(JSON.stringify(frame));
                offset = end;
                frameCount++;

                if (!isLast) setTimeout(sendAudio, 40);
                else console.log(`[Tom] 音频发送完毕 共${frameCount}帧`);
            };

            setTimeout(sendAudio, 40);
        });

        ws.on('message', (rawData) => {
            if (finished) return;
            try {
                const resp = JSON.parse(rawData);

                if (resp.code !== 0) {
                    console.error(`[Tom] 讯飞错误 code=${resp.code} msg=${resp.message}`);
                    return done(new Error(`讯飞错误(${resp.code}): ${resp.message}`));
                }

                if (timeoutTimer) {
                    clearTimeout(timeoutTimer);
                    timeoutTimer = setTimeout(() => { done(new Error('超时')); }, 30000);
                }

                // ====== status=2 是最终结果 ======
                if (resp.data && resp.data.status === 2) {
                    let resultStr = '';
                    try {
                        resultStr = Buffer.from(resp.data.data, 'base64').toString('utf-8');
                    } catch (_) { resultStr = resp.data.data; }

                    console.log('[Tom] 原始结果:', resultStr.substring(0, 300));

                    let score = 0;

                    // 尝试 JSON 解析
                    try {
                        const obj = JSON.parse(resultStr);
                        const w = obj.read_word;
                        if (w?.rec_paper?.read_chapter?.word?.[0]?.total_score != null) {
                            score = w.rec_paper.read_chapter.word[0].total_score;
                        } else if (w?.rec_paper?.read_chapter?.total_score != null) {
                            score = w.rec_paper.read_chapter.total_score;
                        } else if (w?.rec_paper?.total_score != null) {
                            score = w.rec_paper.total_score;
                        }
                    } catch (_) {
                        // 再尝试 XML
                        const m = resultStr.match(/total_score\s+value="([\d.]+)"/);
                        if (m) score = parseFloat(m[1]);
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

