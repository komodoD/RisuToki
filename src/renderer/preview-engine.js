/**
 * RisuToki Preview Engine
 * RisuAI 핵심 처리 파이프라인 포팅 — CBS, 정규식, 로어북, Lua
 * Source: https://github.com/kwaroran/RisuAI
 */
const PreviewEngine = (() => {
  'use strict';

  // ==================== State ====================
  let chatVars = {};
  let globalVars = {};
  let tempVars = {};
  let defaultVarStr = '';
  let userName = 'User';
  let charName = 'Character';
  let charDescription = '';
  let charFirstMessage = '';
  let assetMap = {}; // name → data URI
  let lorebookEntries = []; // for getLoreBooks search
  let localLorebooks = {}; // loreBookId → { content, key, secondKey, alwaysActive }
  let _reloadDisplayRequested = false;
  let _onReloadDisplay = null; // callback set by app.js

  // ==================== Variable System ====================
  function parseKeyValue(str) {
    if (!str) return [];
    const results = [];
    for (const raw of str.split('\n')) {
      const l = raw.trim();
      if (!l || l.startsWith('//') || l.startsWith('#') || l.startsWith('--')) continue;
      // Try '=' separator first, then ':'
      let idx = l.indexOf('=');
      if (idx <= 0) {
        idx = l.indexOf(':');
        if (idx <= 0) continue;
      }
      const key = l.slice(0, idx).trim();
      const val = l.slice(idx + 1).trim();
      if (!key || !/^[a-zA-Z_$]/.test(key)) continue;
      results.push([key, val]);
    }
    return results;
  }

  function getChatVar(key) {
    // Check temp vars first
    const tv = tempVars[key];
    if (tv !== undefined) return String(tv);
    const v = chatVars['$' + key];
    if (v !== undefined) return String(v);
    const defaults = parseKeyValue(defaultVarStr);
    for (const [k, val] of defaults) {
      if (k === key) return val;
    }
    return 'null';
  }

  function setChatVar(key, value) {
    chatVars['$' + key] = String(value);
  }

  function getGlobalChatVar(key) {
    return globalVars[key] !== undefined ? String(globalVars[key]) : 'null';
  }

  function setGlobalChatVar(key, value) {
    globalVars[key] = String(value);
  }

  // ==================== Math Evaluator ====================
  function calcString(expr) {
    try {
      expr = expr.replace(/\$([a-zA-Z_]\w*)/g, (_, name) => {
        const v = getChatVar(name);
        return v === 'null' ? '0' : v;
      });
      const tokens = [];
      let i = 0;
      while (i < expr.length) {
        if (/\s/.test(expr[i])) { i++; continue; }
        if (/[\d.]/.test(expr[i]) || (expr[i] === '-' && (tokens.length === 0 || typeof tokens[tokens.length - 1] === 'string'))) {
          let num = '';
          if (expr[i] === '-') { num = '-'; i++; }
          while (i < expr.length && /[\d.]/.test(expr[i])) { num += expr[i]; i++; }
          tokens.push(parseFloat(num) || 0);
          continue;
        }
        if (i + 1 < expr.length) {
          const two = expr[i] + expr[i + 1];
          if (['<=', '>=', '==', '!=', '&&', '||'].includes(two)) {
            tokens.push(two); i += 2; continue;
          }
        }
        if ('+-*/%^<>|&()'.includes(expr[i])) {
          tokens.push(expr[i]); i++; continue;
        }
        i++;
      }
      const prec = { '||': 1, '&&': 2, '==': 3, '!=': 3, '<': 4, '>': 4, '<=': 4, '>=': 4, '+': 5, '-': 5, '*': 6, '/': 6, '%': 6, '^': 7 };
      const output = [];
      const ops = [];
      for (const t of tokens) {
        if (typeof t === 'number') { output.push(t); continue; }
        if (t === '(') { ops.push(t); continue; }
        if (t === ')') {
          while (ops.length && ops[ops.length - 1] !== '(') output.push(ops.pop());
          ops.pop(); continue;
        }
        while (ops.length && ops[ops.length - 1] !== '(' && (prec[ops[ops.length - 1]] || 0) >= (prec[t] || 0)) {
          output.push(ops.pop());
        }
        ops.push(t);
      }
      while (ops.length) output.push(ops.pop());
      const stack = [];
      for (const t of output) {
        if (typeof t === 'number') { stack.push(t); continue; }
        const b = stack.pop() || 0;
        const a = stack.pop() || 0;
        switch (t) {
          case '+': stack.push(a + b); break;
          case '-': stack.push(a - b); break;
          case '*': stack.push(a * b); break;
          case '/': stack.push(b !== 0 ? a / b : 0); break;
          case '%': stack.push(b !== 0 ? a % b : 0); break;
          case '^': stack.push(Math.pow(a, b)); break;
          case '<': stack.push(a < b ? 1 : 0); break;
          case '>': stack.push(a > b ? 1 : 0); break;
          case '<=': stack.push(a <= b ? 1 : 0); break;
          case '>=': stack.push(a >= b ? 1 : 0); break;
          case '==': stack.push(Math.abs(a - b) < 1e-9 ? 1 : 0); break;
          case '!=': stack.push(Math.abs(a - b) >= 1e-9 ? 1 : 0); break;
          case '&&': stack.push(a && b ? 1 : 0); break;
          case '||': stack.push(a || b ? 1 : 0); break;
          default: stack.push(0);
        }
      }
      const result = stack[0] || 0;
      return Math.round(result * 1000) / 1000;
    } catch (e) {
      return 0;
    }
  }

  // ==================== CBS Parser ====================
  const matcherMap = new Map();

  function registerCoreCBS() {
    const reg = (name, cb, alias) => {
      matcherMap.set(name, cb);
      if (alias) for (const a of alias) matcherMap.set(a, cb);
    };

    // --- Variables ---
    reg('getvar', (_, arg, args) => getChatVar(args[0] || ''));
    reg('setvar', (_, arg, args) => {
      if (arg.runVar) setChatVar(args[0] || '', args[1] || '');
      return '';
    });
    reg('addvar', (_, arg, args) => {
      if (arg.runVar) {
        const cur = parseFloat(getChatVar(args[0] || '')) || 0;
        const add = parseFloat(args[1] || '0') || 0;
        setChatVar(args[0] || '', String(cur + add));
      }
      return '';
    });
    reg('setdefaultvar', (_, arg, args) => {
      if (arg.runVar && getChatVar(args[0] || '') === 'null') {
        setChatVar(args[0] || '', args[1] || '');
      }
      return '';
    });
    reg('getglobalvar', (_, arg, args) => getGlobalChatVar(args[0] || ''));
    reg('setglobalvar', (_, arg, args) => {
      if (arg.runVar) setGlobalChatVar(args[0] || '', args[1] || '');
      return '';
    });
    // Temp vars (reset per message)
    reg('settempvar', (_, arg, args) => {
      if (arg.runVar) tempVars[args[0] || ''] = args[1] || '';
      return '';
    });
    reg('gettempvar', (_, arg, args) => {
      const v = tempVars[args[0] || ''];
      return v !== undefined ? String(v) : 'null';
    });
    reg('button', (_, arg, args) => {
      // RisuAI: {{button::label::triggerName}} → risu-trigger button
      const label = args[0] || 'Button';
      const trigName = args[1] || '';
      return `<button class="cbs-button" risu-trigger="${trigName}">${label}</button>`;
    });

    // --- Names ---
    reg('user', () => userName, ['username', 'persona']);
    reg('char', () => charName, ['charname', 'bot']);

    // --- Character Info ---
    reg('personality', () => charDescription, ['description', 'char_personality']);
    reg('scenario', () => '', ['world']);
    reg('firstmessage', () => charFirstMessage, ['first_message']);
    reg('mesexamples', () => '', ['mes_example', 'example_dialogue']);

    // --- Math ---
    reg('calc', (_, arg, args) => String(calcString(args.join('::'))));

    // --- Random ---
    reg('random', (_, arg, args) => {
      if (!args.length) return '';
      return args[Math.floor(Math.random() * args.length)];
    });
    reg('roll', (_, arg, args) => {
      const max = parseInt(args[0]) || 6;
      return String(Math.floor(Math.random() * max) + 1);
    });
    reg('pick', (_, arg, args) => {
      const n = parseInt(args[0]) || 1;
      const items = args.slice(1);
      const shuffled = [...items].sort(() => Math.random() - 0.5);
      return shuffled.slice(0, n).join(', ');
    });

    // --- Print / Display ---
    reg('print', (_, arg, args) => args.join('::'));
    reg('hidden', () => '');
    reg('comment', () => '', ['//']);
    reg('br', () => '\n', ['newline', 'nl']);

    // --- HTML helpers ---
    reg('img', (_, arg, args) => `<img src="${args[0] || ''}" alt="${args[1] || ''}" style="max-width:100%;">`, ['image']);
    reg('video', (_, arg, args) => `<video src="${args[0] || ''}" controls style="max-width:100%;"></video>`);
    reg('audio', (_, arg, args) => `<audio src="${args[0] || ''}" controls></audio>`);
    reg('color', (_, arg, args) => `<span style="color:${args[0] || '#fff'}">${args[1] || ''}</span>`);
    reg('fontsize', (_, arg, args) => `<span style="font-size:${args[0] || '1em'}">${args[1] || ''}</span>`, ['size']);
    reg('bold', (_, arg, args) => `<strong>${args[0] || ''}</strong>`, ['b']);
    reg('italic', (_, arg, args) => `<em>${args[0] || ''}</em>`, ['i']);
    reg('strike', (_, arg, args) => `<s>${args[0] || ''}</s>`, ['s', 'del']);
    reg('underline', (_, arg, args) => `<u>${args[0] || ''}</u>`, ['u']);

    // --- Date/Time ---
    reg('date', () => new Date().toLocaleDateString('ko-KR'));
    reg('time', () => new Date().toLocaleTimeString('ko-KR'));
    reg('isotime', () => new Date().toISOString());
    reg('unixtime', () => String(Math.floor(Date.now() / 1000)));

    // --- String ops ---
    reg('length', (_, arg, args) => String((args[0] || '').length));
    reg('upper', (_, arg, args) => (args[0] || '').toUpperCase());
    reg('lower', (_, arg, args) => (args[0] || '').toLowerCase());
    reg('trim', (_, arg, args) => (args[0] || '').trim());
    reg('replace', (_, arg, args) => (args[0] || '').replaceAll(args[1] || '', args[2] || ''));
    reg('substr', (_, arg, args) => {
      const s = args[0] || '';
      const start = parseInt(args[1]) || 0;
      const len = args[2] ? parseInt(args[2]) : undefined;
      return s.substr(start, len);
    });
    reg('split', (_, arg, args) => {
      const parts = (args[0] || '').split(args[1] || ',');
      const idx = parseInt(args[2]) || 0;
      return parts[idx] || '';
    });
    reg('reverse', (_, arg, args) => (args[0] || '').split('').reverse().join(''));
    reg('contains', (_, arg, args) => (args[0] || '').includes(args[1] || '') ? '1' : '0');
    reg('index', (_, arg, args) => String((args[0] || '').indexOf(args[1] || '')));

    // --- Comparison helpers ---
    reg('equal', (_, arg, args) => (args[0] || '') === (args[1] || '') ? '1' : '0');
    reg('notequal', (_, arg, args) => (args[0] || '') !== (args[1] || '') ? '1' : '0');
    reg('greater', (_, arg, args) => parseFloat(args[0] || 0) > parseFloat(args[1] || 0) ? '1' : '0');
    reg('less', (_, arg, args) => parseFloat(args[0] || 0) < parseFloat(args[1] || 0) ? '1' : '0');
    reg('greaterorequal', (_, arg, args) => parseFloat(args[0] || 0) >= parseFloat(args[1] || 0) ? '1' : '0');
    reg('lessorequal', (_, arg, args) => parseFloat(args[0] || 0) <= parseFloat(args[1] || 0) ? '1' : '0');
    reg('and', (_, arg, args) => (args[0] && args[0] !== '0' && args[0] !== '') && (args[1] && args[1] !== '0' && args[1] !== '') ? '1' : '0');
    reg('or', (_, arg, args) => (args[0] && args[0] !== '0' && args[0] !== '') || (args[1] && args[1] !== '0' && args[1] !== '') ? '1' : '0');
    reg('not', (_, arg, args) => (!args[0] || args[0] === '0' || args[0] === '') ? '1' : '0');
    reg('ifeq', (_, arg, args) => args[0] === args[1] ? (args[2] || '') : (args[3] || ''));
    reg('ifneq', (_, arg, args) => args[0] !== args[1] ? (args[2] || '') : (args[3] || ''));

    // --- Asset ---
    reg('asset', (_, arg, args) => {
      const name = args[0] || '';
      // Exact match first
      const dataUri = assetMap[name];
      if (dataUri) return `<img src="${dataUri}" alt="${name}" class="cbs-asset">`;
      // Case-insensitive fallback
      const nameLower = name.toLowerCase();
      for (const key of Object.keys(assetMap)) {
        if (key.toLowerCase() === nameLower) return `<img src="${assetMap[key]}" alt="${name}" class="cbs-asset">`;
      }
      if (arg.assets) {
        const asset = arg.assets.find(a => a[0] === name || a[0].toLowerCase() === nameLower);
        if (asset) return `<img src="${asset[1]}" alt="${name}" class="cbs-asset">`;
      }
      return `[asset:${name}]`;
    });
    // {{raw::name}} — returns raw data URI (used in <img src="{{raw::name}}">)
    reg('raw', (_, arg, args) => {
      const name = args[0] || '';
      // Exact match first
      const dataUri = assetMap[name];
      if (dataUri) return dataUri;
      // Case-insensitive fallback
      const nameLower = name.toLowerCase();
      for (const key of Object.keys(assetMap)) {
        if (key.toLowerCase() === nameLower) return assetMap[key];
      }
      if (arg.assets) {
        const asset = arg.assets.find(a => a[0] === name || a[0].toLowerCase() === nameLower);
        if (asset) return asset[1];
      }
      console.warn('[CBS raw] Asset not found:', name);
      return '';
    });

    // --- Misc ---
    reg('idle', () => '');
    reg('lastmessage', (_, arg) => arg.lastMessage || '');
    reg('lastinput', (_, arg) => arg.lastInput || '');
    reg('messagecount', (_, arg) => String(arg.messageCount || 0));
    reg('lastmessageid', (_, arg) => String(arg.messageCount ? arg.messageCount - 1 : 0), ['lastmessageindex']);
    reg('chatindex', (_, arg) => String(arg.chatID ?? -1), ['chat_index']);
    reg('isfirstmsg', (_, arg) => (arg.chatID === 0 || arg.chatID === -1) ? '1' : '0', ['isfirstmessage']);
    reg('slot', () => '');
    reg('originalmessage', () => '', ['original_message']);
    reg('maxcontext', () => '8000');
    reg('lastcharamessage', () => '', ['lastchar']);
    reg('lastusermessage', () => '', ['lastuser']);
    reg('previousmessage', () => '');
    reg('history', () => '', ['chat']);
  }

  // --- CBS Block Parser (stack-based) ---
  function risuChatParser(text, arg) {
    if (!text || typeof text !== 'string') return text || '';
    arg = arg || {};
    arg.runVar = arg.runVar !== false;
    const maxDepth = 20;
    let depth = 0;

    function parse(input) {
      if (depth++ > maxDepth) return input;
      let result = '';
      let i = 0;
      const len = input.length;
      const stack = [];

      while (i < len) {
        if (input[i] === '{' && i + 1 < len && input[i + 1] === '{') {
          i += 2;
          let inner = '';
          let nestLevel = 0;
          while (i < len) {
            if (input[i] === '{' && i + 1 < len && input[i + 1] === '{') {
              nestLevel++; inner += '{{'; i += 2; continue;
            }
            if (input[i] === '}' && i + 1 < len && input[i + 1] === '}') {
              if (nestLevel > 0) { nestLevel--; inner += '}}'; i += 2; continue; }
              i += 2; break;
            }
            inner += input[i]; i++;
          }

          const parsed = parse(inner);

          // Block start (#)
          if (parsed.startsWith('#')) {
            const blockResult = handleBlockStart(parsed.slice(1), arg);
            stack.push(blockResult);
            continue;
          }
          // Block end (/)
          if (parsed.startsWith('/')) {
            let blockData = null;
            for (let si = stack.length - 1; si >= 0; si--) {
              if (stack[si] && stack[si].isBlock) {
                blockData = stack.splice(si, 1)[0];
                break;
              }
            }
            if (blockData) {
              const output = blockData.active ? blockData.content : (blockData.elseContent || '');
              const activeBlock = stack.length > 0 ? stack[stack.length - 1] : null;
              if (activeBlock && activeBlock.isBlock) {
                if (activeBlock.active) activeBlock.content += output;
              } else {
                result += output;
              }
            }
            continue;
          }
          // {{else}} inside a block
          if (parsed.toLowerCase().trim() === 'else') {
            const activeBlock = stack.length > 0 ? stack[stack.length - 1] : null;
            if (activeBlock && activeBlock.isBlock) {
              activeBlock.elseContent = '';
              activeBlock._inElse = true;
              // Swap: content so far goes to the "if-true" side
              // From now on, content accumulates in elseContent
            }
            continue;
          }

          // Regular tag
          const tagResult = matcher(parsed, arg);
          if (tagResult !== null) {
            const activeBlock = stack.length > 0 ? stack[stack.length - 1] : null;
            if (activeBlock && activeBlock.isBlock) {
              if (activeBlock._inElse) {
                if (!activeBlock.active) activeBlock.elseContent = (activeBlock.elseContent || '') + tagResult;
              } else {
                if (activeBlock.active) activeBlock.content += tagResult;
              }
            } else {
              result += tagResult;
            }
            continue;
          }
          // Unknown tag — keep as-is
          const raw = '{{' + inner + '}}';
          const activeBlock2 = stack.length > 0 ? stack[stack.length - 1] : null;
          if (activeBlock2 && activeBlock2.isBlock) {
            if (activeBlock2._inElse) {
              if (!activeBlock2.active) activeBlock2.elseContent = (activeBlock2.elseContent || '') + raw;
            } else {
              if (activeBlock2.active) activeBlock2.content += raw;
            }
          } else {
            result += raw;
          }
          continue;
        }

        // Regular character
        const activeBlock = stack.length > 0 ? stack[stack.length - 1] : null;
        if (activeBlock && activeBlock.isBlock) {
          if (activeBlock._inElse) {
            if (!activeBlock.active) activeBlock.elseContent = (activeBlock.elseContent || '') + input[i];
          } else {
            if (activeBlock.active) activeBlock.content += input[i];
          }
        } else {
          result += input[i];
        }
        i++;
      }

      for (const b of stack) {
        if (b && b.isBlock) {
          result += b.active ? b.content : (b.elseContent || '');
        }
      }

      depth--;
      return result;
    }

    return parse(text);
  }

  function matcher(p1, arg) {
    if (p1.startsWith('? ')) {
      return String(calcString(p1.substring(2)));
    }
    const parts = p1.split('::');
    const name = parts[0].toLowerCase().replace(/[\s_-]/g, '');
    const args = parts.slice(1);
    const cb = matcherMap.get(name);
    if (cb) return cb(p1, arg, args) ?? '';
    return null;
  }

  // FIX: Handle both {{#if::condition}} and {{#if condition}} syntax
  function handleBlockStart(content, arg) {
    // Try :: split first
    const parts = content.split('::');
    let name, args;

    if (parts.length >= 2) {
      // Standard :: syntax: {{#if::$hp > 0}}
      name = parts[0].toLowerCase().replace(/[\s_-]/g, '');
      args = parts.slice(1);
    } else {
      // Space-separated: {{#if $hp > 0}}
      const spaceIdx = content.indexOf(' ');
      if (spaceIdx > 0) {
        name = content.substring(0, spaceIdx).toLowerCase().replace(/[\s_-]/g, '');
        args = [content.substring(spaceIdx + 1)];
      } else {
        name = content.toLowerCase().replace(/[\s_-]/g, '');
        args = [];
      }
    }

    if (name === 'if') {
      const cond = evaluateCondition(args.join('::'));
      return { isBlock: true, active: cond, content: '', elseContent: '', _inElse: false, type: 'if' };
    }
    if (name === 'when') {
      const active = evaluateWhen(args);
      return { isBlock: true, active, content: '', elseContent: '', _inElse: false, type: 'when' };
    }
    if (name === 'each') {
      return { isBlock: true, active: true, content: '', elseContent: '', _inElse: false, type: 'each' };
    }
    if (name === 'pure') {
      return { isBlock: true, active: true, content: '', elseContent: '', _inElse: false, type: 'pure' };
    }
    return { isBlock: true, active: true, content: '', elseContent: '', _inElse: false, type: name };
  }

  // FIX: Support string comparisons in #if
  function evaluateCondition(expr) {
    if (!expr) return false;
    expr = expr.trim();
    if (expr === '1' || expr.toLowerCase() === 'true') return true;
    if (expr === '0' || expr === '' || expr.toLowerCase() === 'false' || expr === 'null') return false;

    // String comparison: var == "string" or var != "string"
    const strCmp = expr.match(/^(.+?)\s*(==|!=|is|isnot)\s*"([^"]*)"$/);
    if (strCmp) {
      let val = strCmp[1].trim();
      if (val.startsWith('$')) val = getChatVar(val.slice(1));
      else if (/^[a-zA-Z_]\w*$/.test(val)) val = getChatVar(val);
      const op = strCmp[2];
      const cmp = strCmp[3];
      if (op === '==' || op === 'is') return val === cmp;
      if (op === '!=' || op === 'isnot') return val !== cmp;
    }

    // Variable check: just a variable name
    if (/^[a-zA-Z_]\w*$/.test(expr)) {
      const v = getChatVar(expr);
      return v !== 'null' && v !== '0' && v !== '' && v !== 'false';
    }
    if (expr.startsWith('$') && /^\$[a-zA-Z_]\w*$/.test(expr)) {
      const v = getChatVar(expr.slice(1));
      return v !== 'null' && v !== '0' && v !== '' && v !== 'false';
    }

    const result = calcString(expr);
    return result !== 0;
  }

  // FIX: Correct or/and chain logic in when
  function evaluateWhen(args) {
    if (args.length < 3) return false;
    const stack = [...args];

    function resolveVar(val) {
      if (/^[a-zA-Z_]\w*$/.test(val)) {
        const v = getChatVar(val);
        if (v !== 'null') return v;
      }
      if (val.startsWith('$')) {
        const v = getChatVar(val.slice(1));
        if (v !== 'null') return v;
      }
      return val;
    }

    let val = resolveVar(stack.shift());
    let result = null;
    let pendingLogic = 'and';

    while (stack.length >= 2) {
      const op = stack.shift().toLowerCase();
      let cmp = resolveVar(stack.shift());
      let cmpResult;
      switch (op) {
        case 'is': cmpResult = val === cmp; break;
        case 'isnot': cmpResult = val !== cmp; break;
        case '>': cmpResult = parseFloat(val) > parseFloat(cmp); break;
        case '<': cmpResult = parseFloat(val) < parseFloat(cmp); break;
        case '>=': cmpResult = parseFloat(val) >= parseFloat(cmp); break;
        case '<=': cmpResult = parseFloat(val) <= parseFloat(cmp); break;
        default: cmpResult = false;
      }

      if (result === null) result = cmpResult;
      else if (pendingLogic === 'and') result = result && cmpResult;
      else if (pendingLogic === 'or') result = result || cmpResult;

      if (stack.length >= 3) {
        pendingLogic = stack.shift().toLowerCase();
        val = resolveVar(stack.shift());
      }
    }
    return result ?? false;
  }

  // ==================== Regex Script Pipeline ====================
  // FIX: Case-insensitive type matching + support both find/in field names
  function processRegex(text, scripts, mode) {
    if (!scripts || !scripts.length) return text;
    const modeLower = mode.toLowerCase();
    const filtered = scripts.filter(s =>
      (s.type || '').toLowerCase() === modeLower &&
      s.ableFlag !== false &&
      (s.find || s.in)
    );
    filtered.sort((a, b) => {
      const orderA = a.replaceOrder ?? extractOrder(a.flag || a.flags || '');
      const orderB = b.replaceOrder ?? extractOrder(b.flag || b.flags || '');
      return orderA - orderB;
    });
    for (const script of filtered) {
      try {
        const find = script.find || script.in || '';
        const replace = script.replace || script.out || '';
        let flags = (script.flag || script.flags || 'g').replace(/<[^>]*>/g, '').trim();
        if (!flags) flags = 'g';
        const regex = new RegExp(find, flags);
        text = text.replace(regex, replace);
      } catch (e) {
        console.warn('[PreviewEngine] Regex error:', e.message, script.comment);
      }
    }
    return text;
  }

  function extractOrder(flagStr) {
    const m = flagStr.match(/<order\s+(\d+)>/i);
    return m ? parseInt(m[1]) : 0;
  }

  // ==================== Lorebook Matching ====================
  function matchLorebook(messages, lorebook, scanDepth) {
    if (!lorebook || !lorebook.length) return [];
    scanDepth = scanDepth || 10;
    const recentMsgs = messages.slice(-scanDepth);
    const searchText = recentMsgs.map(m => m.content || m).join(' ').toLowerCase();
    const activated = [];

    for (let i = 0; i < lorebook.length; i++) {
      const entry = lorebook[i];
      if (entry.mode === 'folder') continue;

      if (entry.alwaysActive) {
        activated.push({ index: i, entry, reason: 'alwaysActive' });
        continue;
      }

      const keys = (entry.key || '').split(',').map(k => k.trim()).filter(Boolean);
      if (!keys.length) continue;

      let keyMatch = false;
      for (const key of keys) {
        if (entry.useRegex) {
          try { if (new RegExp(key, 'i').test(searchText)) { keyMatch = true; break; } } catch (e) {}
        } else {
          if (searchText.includes(key.toLowerCase())) { keyMatch = true; break; }
        }
      }

      if (entry.selective && entry.secondkey) {
        if (!keyMatch) continue;
        const secondKeys = entry.secondkey.split(',').map(k => k.trim()).filter(Boolean);
        let secondMatch = false;
        for (const sk of secondKeys) {
          if (searchText.includes(sk.toLowerCase())) { secondMatch = true; break; }
        }
        if (!secondMatch) continue;
        activated.push({ index: i, entry, reason: 'key+secondkey' });
      } else if (keyMatch) {
        activated.push({ index: i, entry, reason: `key: ${keys.find(k => searchText.includes(k.toLowerCase()))}` });
      }
    }

    activated.sort((a, b) => (a.entry.insertorder || a.entry.order || 100) - (b.entry.insertorder || b.entry.order || 100));
    return activated;
  }

  // ==================== Lua Runtime ====================
  let luaFactory = null;
  let luaEngine = null;
  let luaOutput = [];

  async function initLua(luaCode) {
    if (!window.wasmoon) {
      console.warn('[PreviewEngine] wasmoon not loaded');
      return false;
    }
    try {
      if (!luaFactory) luaFactory = await new window.wasmoon.LuaFactory();
      if (luaEngine) { luaEngine.global.close(); luaEngine = null; }
      luaEngine = await luaFactory.createEngine();

      // wasmoon corrupts return values of JS-bound functions called from Lua.
      // Workaround: value-returning functions use _raw_ prefix and store result
      // in _jsRet Lua global via global.set. Lua wrappers read _jsRet instead.
      const _safeBind = (name, fn) => {
        luaEngine.global.set('_raw_' + name, (...args) => {
          const result = fn(...args);
          const safe = (result != null) ? String(result) : '';
          try {
            luaEngine.global.set('_jsRet', safe);
            // (debug log removed)
          } catch(e) { console.warn('[safeBind] ERROR', name, e); }
          return result;
        });
      };
      _safeBind('getChatVar', (id, key) => getChatVar(key) || '');
      luaEngine.global.set('setChatVar', (id, key, val) => setChatVar(key, String(val)));
      _safeBind('getGlobalVar', (id, key) => getGlobalChatVar(key) || '');
      luaEngine.global.set('setGlobalVar', (id, key, val) => setGlobalChatVar(key, String(val)));
      _safeBind('getName', () => charName || '');
      luaEngine.global.set('setName', (id, name) => { charName = name; });
      _safeBind('getPersonaName', () => userName || '');
      luaEngine.global.set('print', (...args) => {
        const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join('\t');
        luaOutput.push(msg);
      });

      let outputHTML = '';
      luaEngine.global.set('setOutput', (id, html) => { outputHTML = html; });
      _safeBind('getOutput', () => outputHTML || '');

      await luaEngine.doString(`
        json = {}
        function json.decode(str)
          local f = load("return " .. str:gsub('%[', '{'):gsub('%]', '}'):gsub('":', '"]='):gsub('null', 'nil'))
          if f then return f() end
          return nil
        end
        function json.encode(val)
          if type(val) == "table" then
            local isArray = #val > 0
            local parts = {}
            if isArray then
              for _, v in ipairs(val) do parts[#parts+1] = json.encode(v) end
              return "[" .. table.concat(parts, ",") .. "]"
            else
              for k, v in pairs(val) do parts[#parts+1] = '"' .. tostring(k) .. '":' .. json.encode(v) end
              return "{" .. table.concat(parts, ",") .. "}"
            end
          elseif type(val) == "string" then return '"' .. val:gsub('"', '\\\\"') .. '"'
          elseif type(val) == "number" then return tostring(val)
          elseif type(val) == "boolean" then return val and "true" or "false"
          else return "null" end
        end
        function log(val)
          if type(val) == "table" then print(json.encode(val)) else print(tostring(val)) end
        end
        -- RisuAI async compatibility (Lua has no async, wrap as coroutine)
        function async(fn)
          return function(...)
            local args = {...}
            local co = coroutine.create(fn)
            local ok, result = coroutine.resume(co, table.unpack(args))
            if not ok then print("[async error] " .. tostring(result)) end
            return result
          end
        end
        function await(val)
          return val
        end

        -- Listener system (listenEdit / callListenMain)
        local _listeners = {}
        local _outputListeners = {}
        local _inputListeners = {}

        function listenEdit(mode, fn)
          if not _listeners[mode] then _listeners[mode] = {} end
          table.insert(_listeners[mode], fn)
        end

        function listenOutput(fn)
          table.insert(_outputListeners, fn)
        end

        function listenInput(fn)
          table.insert(_inputListeners, fn)
        end

        -- wasmoon workaround: store results in globals (return values get corrupted)
        _callResult = ""
        _lastListenerResult = nil

        -- Chunk-based result storage to bypass wasmoon global.get truncation
        local CHUNK_SIZE = 7000
        function _storeResult(result, modified)
          _callResult_modified = modified and "1" or "0"
          _callResult_chunks = 0
          if modified and result then
            local len = #result
            local chunks = math.ceil(len / CHUNK_SIZE)
            _callResult_chunks = chunks
            for i = 1, chunks do
              _G["_cr_" .. i] = result:sub((i-1)*CHUNK_SIZE + 1, i*CHUNK_SIZE)
            end
          end
          _callResult = result
        end

        function callListenMain(mode, triggerId, content, arg)
          local fns = _listeners[mode]
          local nfns = fns and #fns or 0
          -- (debug print removed)
          if not fns or nfns == 0 then
            _storeResult(content, false)
            return content
          end
          local result = content
          local wasModified = false
          for i, fn in ipairs(fns) do
            _lastListenerResult = nil
            local ok, r = pcall(function()
              local ret = fn(mode, triggerId, result, arg or "{}")
              _lastListenerResult = ret
              return ret
            end)
            local actualResult = _lastListenerResult
            if ok and actualResult ~= nil then
              local s = tostring(actualResult)
              if s ~= triggerId then
                result = s
                wasModified = true
                -- (debug print removed)
              else
                -- (debug print removed)
              end
            elseif not ok then
              print("[Lua listener error] " .. tostring(r))
            end
          end
          _storeResult(result, wasModified)
          -- (debug print removed)
          return result
        end

        function callOutputListeners(triggerId, content)
          local result = content
          local wasModified = false
          for _, fn in ipairs(_outputListeners) do
            _lastListenerResult = nil
            local ok, r = pcall(function()
              local ret = fn(triggerId, result)
              _lastListenerResult = ret
              return ret
            end)
            local actualResult = _lastListenerResult
            if ok and actualResult ~= nil then
              local s = tostring(actualResult)
              if s ~= triggerId then result = s; wasModified = true end
            end
          end
          _storeResult(result, wasModified)
          return result
        end

        function callInputListeners(triggerId, content)
          local result = content
          local wasModified = false
          for _, fn in ipairs(_inputListeners) do
            _lastListenerResult = nil
            local ok, r = pcall(function()
              local ret = fn(triggerId, result)
              _lastListenerResult = ret
              return ret
            end)
            local actualResult = _lastListenerResult
            if ok and actualResult ~= nil then
              local s = tostring(actualResult)
              if s ~= triggerId then result = s; wasModified = true end
            end
          end
          _storeResult(result, wasModified)
          return result
        end

        function _debugListeners()
          -- (debug prints removed)
        end
      `);
      // JS callback for capturing Lua results (2-step workaround for wasmoon return value bug)
      let _luaCaptured = '';
      luaEngine.global.set('_capture', (val) => { _luaCaptured = (val != null) ? String(val) : ''; });
      initLua._getCaptured = () => _luaCaptured;
      initLua._resetCaptured = () => { _luaCaptured = ''; };

      _safeBind('callAxModel', () => '[Preview] AI model not available');
      // getLoreBooks: search lorebook entries (file + local) and set result as Lua table
      luaEngine.global.set('_raw_getLoreBooks', (id, filter) => {
        const filterStr = (filter != null) ? String(filter).trim() : '';
        if (!filterStr) {
          try { luaEngine.global.set('_lbResult', []); } catch(e) {}
          return;
        }
        const f = filterStr.toLowerCase();
        // Search file lorebook entries
        const fileMatches = lorebookEntries.filter(e => {
          const comment = (e.comment || '').toLowerCase();
          if (comment.includes(f)) return true;
          const keys = Array.isArray(e.key) ? e.key : (e.key || '').split(',');
          return keys.some(k => k.trim().toLowerCase().includes(f));
        }).map(e => ({
          content: e.content || '',
          comment: e.comment || '',
          key: Array.isArray(e.key) ? e.key.join(',') : (e.key || ''),
        }));
        // Search local (Lua-created) lorebook entries
        const localMatches = [];
        for (const [lbId, entry] of Object.entries(localLorebooks)) {
          // alwaysActive entries always match
          if (entry.alwaysActive) {
            localMatches.push({ content: entry.content, comment: lbId, key: entry.key || '' });
            continue;
          }
          const keyStr = (entry.key || '').toLowerCase();
          const secKeyStr = (entry.secondKey || '').toLowerCase();
          const commentStr = lbId.toLowerCase();
          if (commentStr.includes(f) || keyStr.includes(f) || secKeyStr.includes(f)) {
            localMatches.push({ content: entry.content, comment: lbId, key: entry.key || '' });
          }
        }
        const matches = [...fileMatches, ...localMatches];
        // Store results as individual globals (wasmoon can't convert JS arrays to Lua tables)
        try {
          luaEngine.global.set('_lbCount', matches.length);
          for (let i = 0; i < matches.length; i++) {
            luaEngine.global.set('_lb_' + i + '_content', matches[i].content || '');
            luaEngine.global.set('_lb_' + i + '_comment', matches[i].comment || '');
            luaEngine.global.set('_lb_' + i + '_key', matches[i].key || '');
          }
        } catch(e) {
          console.warn('[getLoreBooks] set result error:', e);
          try { luaEngine.global.set('_lbCount', 0); } catch(e2) {}
        }
      });
      luaEngine.global.set('upsertLocalLoreBook', (id, lbId, content, opts) => {
        const lbIdStr = String(lbId || '');
        if (!lbIdStr) return;
        const entry = { content: String(content || '') };
        if (opts && typeof opts === 'object') {
          if (opts.key) entry.key = String(opts.key);
          if (opts.secondKey) entry.secondKey = String(opts.secondKey);
          if (opts.alwaysActive !== undefined) entry.alwaysActive = !!opts.alwaysActive;
        }
        localLorebooks[lbIdStr] = entry;
      });
      luaEngine.global.set('removeLocalLoreBook', (id, lbId) => {
        delete localLorebooks[String(lbId || '')];
      });
      _safeBind('getChat', () => '[]');
      luaEngine.global.set('setChat', (id, chat) => { /* stub */ });
      _safeBind('getMemory', () => '');
      luaEngine.global.set('setMemory', (id, mem) => { /* stub */ });
      _safeBind('getCharacterName', () => charName || '');
      luaEngine.global.set('alertError', (msg) => { luaOutput.push('[Alert] ' + msg); });
      _safeBind('requestInput', () => '');
      luaEngine.global.set('sleep', (ms) => { /* stub */ });

      // Additional RisuAI Lua API stubs
      _safeBind('getCharacterLastMessage', () => charFirstMessage || '');
      _safeBind('getUserLastMessage', () => '');
      _safeBind('getChatLength', () => '1');
      _safeBind('getFullChat', () => '[]');
      _safeBind('getChatMessages', () => '[]');
      _safeBind('getLastMessage', () => charFirstMessage || '');
      _safeBind('getCurrentChatId', () => 'preview');
      _safeBind('getCharacterId', () => 'preview');
      luaEngine.global.set('setDescription', (id, desc) => { /* stub */ });
      luaEngine.global.set('setPersonality', (id, p) => { /* stub */ });
      luaEngine.global.set('setScenario', (id, s) => { /* stub */ });
      luaEngine.global.set('setFirstMessage', (id, m) => { /* stub */ });
      luaEngine.global.set('addChat', (id, role, content) => { /* stub */ });
      luaEngine.global.set('removeChat', (id, idx) => { /* stub */ });
      luaEngine.global.set('reloadDisplay', (id) => {
        _reloadDisplayRequested = true;
        if (_onReloadDisplay) _onReloadDisplay();
      });
      luaEngine.global.set('sendInput', (id, text) => { /* stub */ });

      // Lua wrappers: call raw JS function (side-effect: sets _jsRet), then return _jsRet
      await luaEngine.doString(`
        _jsRet = ""
        function getChatVar(id, key)
          _raw_getChatVar(id, key)
          return _jsRet
        end
        function getGlobalVar(id, key)
          _raw_getGlobalVar(id, key)
          return _jsRet
        end
        function getName() _raw_getName(); return _jsRet end
        function getPersonaName() _raw_getPersonaName(); return _jsRet end
        function getOutput() _raw_getOutput(); return _jsRet end
        function callAxModel(id, sys, usr, opts) _raw_callAxModel(id, sys, usr, opts); return _jsRet end
        function getLoreBooks(id, filter)
          _raw_getLoreBooks(id, filter or "")
          local count = _lbCount
          if count == nil or count == 0 then return {} end
          if type(count) == "string" then count = tonumber(count) or 0 end
          local result = {}
          for i = 0, count - 1 do
            result[i + 1] = {
              content = _G["_lb_" .. i .. "_content"] or "",
              comment = _G["_lb_" .. i .. "_comment"] or "",
              key = _G["_lb_" .. i .. "_key"] or "",
            }
          end
          return result
        end
        function getChat(id) _raw_getChat(id); return _jsRet end
        function getMemory(id) _raw_getMemory(id); return _jsRet end
        function getCharacterName() _raw_getCharacterName(); return _jsRet end
        function requestInput(id, prompt) _raw_requestInput(id, prompt); return _jsRet end
        function getCharacterLastMessage(id) _raw_getCharacterLastMessage(id); return _jsRet end
        function getUserLastMessage(id) _raw_getUserLastMessage(id); return _jsRet end
        function getChatLength(id) _raw_getChatLength(id); return _jsRet end
        function getFullChat(id) _raw_getFullChat(id); return _jsRet end
        function getChatMessages(id) _raw_getChatMessages(id); return _jsRet end
        function getLastMessage(id) _raw_getLastMessage(id); return _jsRet end
        function getCurrentChatId() _raw_getCurrentChatId(); return _jsRet end
        function getCharacterId() _raw_getCharacterId(); return _jsRet end
      `);

      if (luaCode) {
        const cleanCode = luaCode.replace(/^-- ===== .* =====$/gm, '');
        await luaEngine.doString(cleanCode);
      }
      return true;
    } catch (e) {
      console.error('[PreviewEngine] Lua init error:', e);
      luaOutput.push('[Lua Error] ' + e.message);
      return false;
    }
  }

  // Helper: call Lua function via doString to avoid wasmoon return-value bugs
  async function luaCall(code) {
    if (!luaEngine) return null;
    await luaEngine.doString(code);
    return luaEngine.global.get('_jsResult');
  }

  // Read _callResult from Lua using chunk-based approach to bypass wasmoon truncation
  function _readCallResult(data) {
    const modified = luaEngine.global.get('_callResult_modified');
    if (modified !== '1') {
      return data; // no-op: return original data without reading truncated global
    }
    const chunks = luaEngine.global.get('_callResult_chunks');
    if (chunks && chunks > 0) {
      let result = '';
      for (let i = 1; i <= chunks; i++) {
        const chunk = luaEngine.global.get('_cr_' + i);
        if (chunk != null) result += String(chunk);
      }
      // (debug log removed)
      return result.length > 0 ? result : data;
    }
    // Fallback: try direct read
    const r = luaEngine.global.get('_callResult');
    const rs = (r != null) ? String(r) : '';
    // (debug log removed)
    return (rs.length > 0 && rs !== 'nil') ? rs : data;
  }

  async function runLuaTrigger(mode, data) {
    if (!luaEngine) return data;
    try {
      if (mode === '_debug_listeners') {
        await luaEngine.doString(`_debugListeners()`);
        return data;
      }
      if (mode === 'start') {
        await luaEngine.doString(`
          _debugListeners()
          if onStart then onStart("preview") end
        `);
        return data;
      }
      if (mode === 'input') {
        await luaEngine.doString(`if onInput then onInput("preview") end`);
        const content = typeof data === 'string' ? data : JSON.stringify(data);
        luaEngine.global.set('_jsContent', content);
        await luaEngine.doString(`callInputListeners("preview", _jsContent)`);
        return _readCallResult(data);
      }
      if (mode === 'output') {
        await luaEngine.doString(`if onOutput then onOutput("preview") end`);
        const content = typeof data === 'string' ? data : JSON.stringify(data);
        luaEngine.global.set('_jsContent', content);
        await luaEngine.doString(`callOutputListeners("preview", _jsContent)`);
        return _readCallResult(data);
      }
      if (mode === 'editOutput') {
        await luaEngine.doString(`if onOutput then onOutput("preview") end`);
      }
      // editDisplay, editOutput, editInput, editRequest → callListenMain
      const content = typeof data === 'string' ? data : JSON.stringify(data);
      luaEngine.global.set('_jsContent', content);
      luaEngine.global.set('_jsMode', mode);
      await luaEngine.doString(`callListenMain(_jsMode, "preview", _jsContent, "{}")`);
      return _readCallResult(data);
    } catch (e) {
      luaOutput.push(`[Lua ${mode} Error] ${e.message}`);
      console.warn(`[Lua ${mode} Error]`, e);
      return data;
    }
  }

  // ==================== Initialize ====================
  registerCoreCBS();

  // ==================== Public API ====================
  return {
    setChatVar,
    getChatVar,
    setGlobalChatVar,
    getGlobalChatVar,
    setUserName: (n) => { userName = n; },
    setCharName: (n) => { charName = n; },
    setDefaultVars: (s) => { defaultVarStr = s; },
    setCharDescription: (s) => { charDescription = s; },
    setCharFirstMessage: (s) => { charFirstMessage = s; },
    setAssets: (map) => {
      assetMap = map || {};
    },
    setLorebook: (entries) => { lorebookEntries = entries || []; },
    resetVars: () => { chatVars = {}; globalVars = {}; tempVars = {}; localLorebooks = {}; _reloadDisplayRequested = false; luaOutput = []; },
    clearTempVars: () => { tempVars = {}; },
    onReloadDisplay: (cb) => { _onReloadDisplay = cb; },
    consumeReloadRequest: () => { const r = _reloadDisplayRequested; _reloadDisplayRequested = false; return r; },

    risuChatParser,
    processRegex,
    matchLorebook,
    calcString,
    // Replace img src with asset data URIs
    resolveAssetImages: (html) => {
      if (!html || !assetMap || Object.keys(assetMap).length === 0) return html;
      const unresolved = new Set();
      const result = html.replace(/<img\s([^>]*?)src="([^"]+)"([^>]*?)>/gi, (match, pre, src, post) => {
        // Skip if already a data URI or full URL
        if (src.startsWith('data:') || src.startsWith('http') || src.startsWith('blob:')) return match;
        // Try exact match
        if (assetMap[src]) return `<img ${pre}src="${assetMap[src]}"${post}>`;
        // Case-insensitive
        const srcLower = src.toLowerCase();
        for (const key of Object.keys(assetMap)) {
          if (key.toLowerCase() === srcLower) return `<img ${pre}src="${assetMap[key]}"${post}>`;
        }
        unresolved.add(src);
        return match;
      });
      // (debug warn removed)
      return result;
    },

    initLua,
    runLuaTrigger,
    runLuaButtonClick: async (chatId, data) => {
      if (!luaEngine) return;
      try {
        luaEngine.global.set('_btnChatId', String(chatId));
        luaEngine.global.set('_btnData', String(data));
        await luaEngine.doString(`
          if onButtonClick then
            onButtonClick(_btnChatId, _btnData)
          end
        `);
      } catch (e) { console.warn('[runLuaButtonClick]', e); }
    },
    runLuaTriggerByName: async (name) => {
      if (!luaEngine) return;
      try {
        luaEngine.global.set('_trigName', String(name));
        await luaEngine.doString(`
          if _triggers and _triggers[_trigName] then
            _triggers[_trigName]()
          end
        `);
      } catch (e) { console.warn('[runLuaTriggerByName]', e); }
    },

    getLuaOutput: () => [...luaOutput],
    getLuaOutputHTML: () => {
      if (!luaEngine) return '';
      const fn = luaEngine.global.get('getOutput');
      return typeof fn === 'function' ? (fn() || '') : '';
    },
    getVariables: () => {
      // Merge: defaults → chatVars (chatVars overrides defaults)
      const merged = {};
      for (const [k, v] of parseKeyValue(defaultVarStr)) {
        merged['$' + k] = v;
      }
      Object.assign(merged, chatVars);
      return merged;
    },
  };
})();
