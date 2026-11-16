// api/analyze.js (部署在 Vercel 上的 Serverless 接口)
export default async function handler(req, res) {
    // 允许跨域
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const { csvText, apiKey } = req.body;
        if (!csvText) {
            return res.status(400).json({ error: '请提供聊天记录 CSV 文本' });
        }

        // 优先使用前端传过来的 Key，如果没有则降级读取 Vercel 环境变量里的全局 Key
        const finalApiKey = apiKey || process.env.DEEPSEEK_API_KEY;
        if (!finalApiKey) {
            return res.status(400).json({ error: '未检测到 API Key，请在前端输入或在 Vercel 环境变量中配置。' });
        }

        // 后端进行智能全景采样（控流防止超长）
        let lines = csvText.split('\n').filter(l => l.trim().length > 0);
        let sampledLines = [];
        if (lines.length > 2000) {
            let step = Math.floor(lines.length / 2000);
            for (let i = 0; i < lines.length; i += step) {
                sampledLines.push(lines[i]);
            }
        } else {
            sampledLines = lines;
        }
        let payloadText = sampledLines.join('\n');

        const prompt = `你是一个高级对话数据分析师。下面是一份真实微信聊天记录 CSV 文本（横跨多个年份，如2024至2026年）。请按【年份分段】提取高频词，并严格输出合法的紧凑 JSON 格式（绝对不要包含任何 markdown 符号如 \`\`\`json，只输出纯 JSON）：
{
  "montage": [
    {"date": "2024.11", "sender": "某某", "text": "2024年真实对话金句"},
    {"date": "2025.06", "sender": "某某", "text": "2025年真实对话金句"},
    {"date": "2026.03", "sender": "某某", "text": "2026年真实对话金句"}
  ],
  "nodes": [
    {
      "word": "全局唯一的高频实词或专有名词(2-4字)",
      "count": 120,
      "snippets": [
        {
          "date": "2024/09/30",
          "messages": [
            {"sender": "某某", "time": "2024/09/30 10:37", "text": "前置句", "highlight": false},
            {"sender": "某某", "time": "2024/09/30 10:38", "text": "中心句", "highlight": true}
          ]
        }
      ]
    }
  ]
}
严格要求：
1. 【绝对去重】：绝不允许同一个词在 nodes 里出现两次，所有词条必须全局唯一！
2. 【时间覆盖】：兼顾 2024、2025、2026 全时段。
3. 提取 18-22 个全局唯一的 nodes 节点，以及 25 条跨年蒙太奇对话。
聊天记录内容如下：\n` + payloadText;

        // 请求 DeepSeek API
        const aiResponse = await fetch("https://api.deepseek.com/chat/completions", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${finalApiKey}`
            },
            body: JSON.stringify({
                model: "deepseek-chat",
                messages: [{"role": "user", "content": prompt}],
                temperature: 0.3,
                max_tokens: 4096
            })
        });

        const aiData = await aiResponse.json();
        if (!aiData.choices || !aiData.choices[0]) {
            throw new Error("DeepSeek API 返回结构异常");
        }

        let content = aiData.choices[0].message.content;
        
        // 后端强力清洗与括号自动补全机制
        content = content.replace(/```json/g, '').replace(/```/g, '').trim();
        let firstBrace = content.indexOf('{');
        let lastBrace = content.lastIndexOf('}');
        
        if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
            content = content.substring(firstBrace, lastBrace + 1);
        } else if (firstBrace !== -1) {
            content = content.substring(firstBrace) + "\n  ] \n}";
        }

        let parsedData;
        try {
            parsedData = JSON.parse(content);
        } catch (e) {
            let fixedContent = content.replace(/,\s*$/, "") + "\n  ]\n}";
            parsedData = JSON.parse(fixedContent);
        }

        // 后端双重去重安全网
        let uniqueNodesMap = new Map();
        if (parsedData.nodes) {
            parsedData.nodes.forEach(node => {
                if (!uniqueNodesMap.has(node.word)) {
                    uniqueNodesMap.set(node.word, node);
                }
            });
            parsedData.nodes = Array.from(uniqueNodesMap.values());
        }

        return res.status(200).json(parsedData);

    } catch (error) {
        console.error("Backend Error:", error);
        return res.status(500).json({ error: error.message || "后端解析失败" });
    }
}
