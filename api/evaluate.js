// api/evaluate.js - Vercel Serverless Function
// 讯飞语音评测API后端

const crypto = require('crypto');
const WebSocket = require('ws');

// 讯飞API配置（部署时需要在Vercel环境变量中设置）
const XFYUN_CONFIG = {
  APPID: process.env.XFYUN_APPID,
  API_SECRET: process.env.XFYUN_API_SECRET,
  API_KEY: process.env.XFYUN_API_KEY,
  HOST: 'ise-api.xfyun.cn',
  URI: '/v2/open-ise'
};

// 生成鉴权URL
function getAuthUrl() {
  const date = new Date().toUTCString();
  const signatureOrigin = `host: ${XFYUN_CONFIG.HOST}\ndate: ${date}\nGET ${XFYUN_CONFIG.URI} HTTP/1.1`;
  
  const hmac = crypto.createHmac('sha256', XFYUN_CONFIG.API_SECRET);
  const signature = hmac.update(signatureOrigin).digest('base64');
  
  const authorizationOrigin = `api_key="${XFYUN_CONFIG.API_KEY}", algorithm="hmac-sha256", headers="host date request-line", signature="${signature}"`;
  const authorization = Buffer.from(authorizationOrigin).toString('base64');
  
  return `wss://${XFYUN_CONFIG.HOST}${XFYUN_CONFIG.URI}?authorization=${authorization}&date=${encodeURIComponent(date)}&host=${XFYUN_CONFIG.HOST}`;
}

// 主处理函数
module.exports = async (req, res) => {
  // 设置CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { audio, text } = req.body;
    
    if (!audio || !text) {
      return res.status(400).json({ error: 'Missing audio or text' });
    }

    // 检查配置
    if (!XFYUN_CONFIG.APPID || !XFYUN_CONFIG.API_SECRET || !XFYUN_CONFIG.API_KEY) {
      return res.status(500).json({ error: 'Server configuration error' });
    }

    // 调用讯飞API评测
    const result = await evaluateAudio(audio, text);
    
    return res.status(200).json(result);
    
  } catch (error) {
    console.error('Evaluation error:', error);
    return res.status(500).json({ 
      error: 'Evaluation failed',
      message: error.message 
    });
  }
};

// 调用讯飞API进行评测
function evaluateAudio(audioBase64, text) {
  return new Promise((resolve, reject) => {
    const wsUrl = getAuthUrl();
    const ws = new WebSocket(wsUrl);
    
    let result = null;
    
    ws.on('open', () => {
      // 发送评测参数
      const params = {
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
          text: Buffer.from(text).toString('base64'),
          ttp_skip: true,
          aus: 1
        },
        data: {
          status: 2,
          encoding: 'raw',
          audio: audioBase64,
          data_type: 1
        }
      };
      
      ws.send(JSON.stringify(params));
    });
    
    ws.on('message', (data) => {
      const response = JSON.parse(data);
      
      if (response.code !== 0) {
        ws.close();
        reject(new Error(`API Error: ${response.message}`));
        return;
      }
      
      if (response.data) {
        result = response.data;
      }
      
      // 结果返回完成
      if (response.data && response.data.status === 2) {
        ws.close();
        
        // 解析评测结果
        const evalResult = parseEvaluationResult(result);
        resolve(evalResult);
      }
    });
    
    ws.on('error', (error) => {
      reject(error);
    });
    
    ws.on('close', () => {
      if (!result) {
        reject(new Error('Connection closed without result'));
      }
    });
    
    // 超时处理
    setTimeout(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
        reject(new Error('Evaluation timeout'));
      }
    }, 10000);
  });
}

// 解析评测结果
function parseEvaluationResult(data) {
  try {
    const resultStr = Buffer.from(data.data, 'base64').toString('utf-8');
    const resultObj = JSON.parse(resultStr);
    
    // 提取分数
    const score = resultObj.read_word?.rec_paper?.read_chapter?.word?.[0]?.total_score || 0;
    const accuracy = resultObj.read_word?.rec_paper?.read_chapter?.word?.[0]?.accuracy_score || 0;
    const fluency = resultObj.read_word?.rec_paper?.read_chapter?.word?.[0]?.fluency_score || 0;
    
    return {
      success: true,
      score: Math.round(score),
      accuracy: Math.round(accuracy),
      fluency: Math.round(fluency),
      details: resultObj
    };
  } catch (error) {
    console.error('Parse error:', error);
    return {
      success: false,
      error: 'Failed to parse result'
    };
  }
}
