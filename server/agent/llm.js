'use strict';
/**
 * 大模型网关（OpenAI 兼容）。API Key 只在这里从后端配置读取，永不下发前端。
 * 未配置 LLM_* 时，系统自动降级为本地意图引擎（离线演示模式）。
 */
const config = require('../config');

async function chatStream({ messages, tools, onDelta, temperature = 0.3 }) {
  const url = `${config.llm.baseUrl}/chat/completions`;
  const body = {
    model: config.llm.model,
    messages,
    temperature,
    stream: true,
  };
  if (tools && tools.length) { body.tools = tools; body.tool_choice = 'auto'; }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.llm.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    throw new Error(`连接大模型失败：${e.message}`);
  }
  if (!res.ok) {
    clearTimeout(timer);
    const txt = await res.text().catch(() => '');
    throw new Error(`大模型返回 ${res.status}：${txt.slice(0, 300)}`);
  }

  const decoder = new TextDecoder('utf-8');
  let buf = '';
  let content = '';
  const toolCalls = [];

  const handleLine = (line) => {
    const s = line.trim();
    if (!s.startsWith('data:')) return;
    const data = s.slice(5).trim();
    if (!data || data === '[DONE]') return;
    let json;
    try { json = JSON.parse(data); } catch { return; }
    const delta = json.choices && json.choices[0] && json.choices[0].delta;
    if (!delta) return;
    if (delta.content) {
      content += delta.content;
      if (onDelta) onDelta(delta.content);
    }
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index || 0;
        if (!toolCalls[idx]) toolCalls[idx] = { id: tc.id || `call_${idx}`, type: 'function', function: { name: '', arguments: '' } };
        if (tc.id) toolCalls[idx].id = tc.id;
        if (tc.function && tc.function.name) toolCalls[idx].function.name += tc.function.name;
        if (tc.function && tc.function.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
      }
    }
  };

  try {
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        handleLine(line);
      }
    }
    if (buf.trim()) handleLine(buf);
  } finally {
    clearTimeout(timer);
  }

  return { content, toolCalls: toolCalls.filter(Boolean) };
}

module.exports = { chatStream, enabled: () => config.llmEnabled, info: () => ({ baseUrl: config.llm.baseUrl, model: config.llm.model }) };
