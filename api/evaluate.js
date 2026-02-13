function evaluateAudio(audioBase64, text) {
    return new Promise((resolve, reject) => {
        let finished = false;
        const ws = new WebSocket(getAuthUrl());
        const audioBuffer = Buffer.from(audioBase64, 'base64');
        const FRAME_SIZE = 1280;
        let offset = 0;

        // 尝试更简洁的文本格式
        const iseText = '\uFEFF' + text; 

        ws.on('open', () => {
            console.log('[Tom] WS已连接，开始发送数据流...');

            const sendNext = () => {
                if (finished || ws.readyState !== WebSocket.OPEN) return;

                const isFirst = (offset === 0);
                const chunk = audioBuffer.slice(offset, Math.min(offset + FRAME_SIZE, audioBuffer.length));
                const isLast = (offset + chunk.length >= audioBuffer.length);
                
                const frame = {
                    data: {
                        status: isFirst ? 0 : (isLast ? 2 : 1),
                        encoding: 'raw',
                        data_type: 1,
                        data: chunk.toString('base64')
                    }
                };

                // 首帧必须包含 business 和 common
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
                        text: Buffer.from('\ufeff' + text).toString('base64'), // 文本也转成base64更稳
                        ttp_skip: true
                    };
                }

                ws.send(JSON.stringify(frame));
                offset += chunk.length;

                if (!isLast) {
                    setTimeout(sendNext, 40);
                }
            };

            sendNext();
        });

        ws.on('message', (data) => {
            const resp = JSON.parse(data);
            if (resp.code !== 0) {
                console.error('[Tom] 讯飞业务错误:', resp.message);
                ws.terminate();
                return reject(new Error(resp.message));
            }

            if (resp.data && resp.data.status === 2) {
                finished = true;
                const resultStr = Buffer.from(resp.data.data, 'base64').toString('utf-8');
                console.log('[Tom] 原始结果:', resultStr);
                
                // 增强版解析逻辑
                let score = 0;
                try {
                    // 1. 尝试解析 JSON
                    const obj = JSON.parse(resultStr);
                    const wordData = obj.read_word?.rec_paper?.read_chapter?.word?.[0] || 
                                   obj.read_word?.rec_paper?.read_chapter || {};
                    score = wordData.total_score || 0;
                } catch (e) {
                    // 2. 尝试正则匹配 XML
                    const match = resultStr.match(/total_score="([\d.]+)"/) || 
                                 resultStr.match(/total_score value="([\d.]+)"/);
                    if (match) score = parseFloat(match[1]);
                }

                ws.close();
                resolve({ success: true, score: Math.round(score) });
            }
        });

        ws.on('error', (err) => reject(err));
        ws.on('close', () => { if(!finished) reject(new Error('连接意外关闭')); });
        setTimeout(() => { if(!finished) { ws.terminate(); reject(new Error('评测超时')); } }, 20000);
    });
}
