// AudioManager - 说书人控制台专用的语音朗读 / 背景音乐 / 提示音封装
// 音频文件约定（用户自行放入，缺失时静默跳过）：
//   static/audio/bgm/setup.mp3, night.mp3, day.mp3
//   static/audio/sfx/turn.mp3, phase.mp3, timer_end.mp3, execution.mp3

const AudioManager = (() => {
    let settings = {
        ttsEnabled: true,
        bgmEnabled: true,
        bgmVolume: 0.4,
        sfxEnabled: true,
        sfxVolume: 0.6
    };

    let unlocked = false;
    let currentBgmKey = null;
    let currentBgmEl = null;
    const warnedMissing = new Set();

    // ===== 浏览器内置语音（仅作为 edge-tts 不可用时的兜底） =====
    // 很多浏览器（尤其 Chrome）在页面刚打开时 speechSynthesis.getVoices() 会返回空数组，
    // 语音列表是异步加载的；如果在加载完成前调用，有些浏览器会直接静默失败。
    let cachedVoices = [];
    let pickedVoice = null;

    function pickChineseVoice() {
        if (!cachedVoices.length) return null;
        return (
            cachedVoices.find(v => v.lang === 'zh-CN') ||
            cachedVoices.find(v => v.lang && v.lang.toLowerCase().startsWith('zh')) ||
            cachedVoices[0] ||
            null
        );
    }

    function refreshVoices() {
        if (!('speechSynthesis' in window)) return;
        cachedVoices = window.speechSynthesis.getVoices() || [];
        pickedVoice = pickChineseVoice();
    }

    if ('speechSynthesis' in window) {
        refreshVoices();
        window.speechSynthesis.addEventListener('voiceschanged', refreshVoices);
    }

    function updateSettings(newSettings) {
        settings = { ...settings, ...newSettings };
        if (currentBgmEl) {
            currentBgmEl.volume = settings.bgmVolume;
            if (!settings.bgmEnabled) {
                currentBgmEl.pause();
            } else if (unlocked) {
                currentBgmEl.play().catch(() => {});
            }
        }
    }

    function warnOnce(path) {
        if (!warnedMissing.has(path)) {
            warnedMissing.add(path);
            console.warn(`[AudioManager] 未找到音频文件: ${path}（可忽略，功能不受影响）`);
        }
    }

    function unlock() {
        unlocked = true;
        if (currentBgmEl && settings.bgmEnabled) {
            currentBgmEl.play().catch(() => {});
        }
    }

    // ===== TTS 播报队列 =====
    // 优先用服务端的 edge-tts（更自然、也不受浏览器"标签页不在前台不出声"这类坑影响），
    // 生成失败（没网/服务端出错）时回退到浏览器自带的 speechSynthesis。
    // 排队播放：新的播报追加到队尾，等前一句读完了再读下一句，不会互相打断。
    const speechQueue = [];
    let isSpeaking = false;
    let watchdogTimer = null;
    const ttsUrlCache = new Map(); // text -> 已经拿到过的音频 URL，避免重复请求同一句话

    function speakWithBrowser(text, advance) {
        if (!('speechSynthesis' in window)) {
            console.warn('[AudioManager] 当前浏览器不支持语音朗读 (speechSynthesis)，且 edge-tts 也不可用');
            advance('浏览器不支持');
            return;
        }
        try {
            const utter = new SpeechSynthesisUtterance(text);
            utter.lang = 'zh-CN';
            if (pickedVoice) {
                utter.voice = pickedVoice;
            } else if (!cachedVoices.length) {
                refreshVoices();
                if (pickedVoice) utter.voice = pickedVoice;
            }
            utter.onend = () => advance('浏览器朗读 onend');
            utter.onerror = (e) => {
                console.warn('[AudioManager] 浏览器朗读出错', e.error, text);
                advance('浏览器朗读 onerror');
            };
            window.speechSynthesis.speak(utter);
        } catch (e) {
            console.warn('[AudioManager] 浏览器朗读失败', e);
            advance('浏览器朗读异常');
        }
    }

    async function fetchTtsUrl(text) {
        if (ttsUrlCache.has(text)) return ttsUrlCache.get(text);
        const res = await fetch('/api/tts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text })
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
            throw new Error(data.error || `HTTP ${res.status}`);
        }
        ttsUrlCache.set(text, data.url);
        return data.url;
    }

    async function processQueue() {
        if (isSpeaking || speechQueue.length === 0) return;

        const item = speechQueue.shift();
        const text = item.text;
        isSpeaking = true;
        console.debug(`[AudioManager] 开始朗读："${text}"（队列剩余 ${speechQueue.length} 条）`);

        let advanced = false;
        const advance = (reason) => {
            if (advanced) return; // 播放完成/出错/看门狗只应该有一个真正生效，避免重复推进队列
            advanced = true;
            clearTimeout(watchdogTimer);
            console.debug(`[AudioManager] 朗读结束："${text}"（${reason}）`);
            isSpeaking = false;
            if (item.onDone) item.onDone();
            processQueue();
        };

        // 部分情况下音频播放事件可能完全不触发（网络卡住等），用看门狗兜底避免队列卡死
        const estimatedMs = Math.max(6000, text.length * 600);
        watchdogTimer = setTimeout(() => advance('watchdog 超时兜底'), estimatedMs);

        try {
            const url = await fetchTtsUrl(text);
            const audio = new Audio(url);
            audio.onended = () => advance('edge-tts 播放完成');
            audio.onerror = () => {
                console.warn('[AudioManager] edge-tts 音频播放失败，回退到浏览器朗读', text);
                clearTimeout(watchdogTimer);
                speakWithBrowser(text, advance);
            };
            await audio.play();
        } catch (e) {
            console.warn('[AudioManager] edge-tts 生成失败，回退到浏览器朗读', e, text);
            clearTimeout(watchdogTimer);
            speakWithBrowser(text, advance);
        }
    }

    function speak(text) {
        if (!settings.ttsEnabled || !text) return;
        console.debug(`[AudioManager] speak() 被调用："${text}"`);
        speechQueue.push({ text });
        processQueue();
    }

    // 跟 speak() 一样排队播报，但返回一个 Promise，在这句话真正读完（或读失败兜底）后才 resolve——
    // 用于"必须等这句播报完，才能继续往下推进流程"的场合（比如先读完"XX请睁眼"，再显示私密信息）
    function speakAndWait(text) {
        if (!settings.ttsEnabled || !text) return Promise.resolve();
        console.debug(`[AudioManager] speakAndWait() 被调用："${text}"`);
        return new Promise(resolve => {
            speechQueue.push({ text, onDone: resolve });
            processQueue();
        });
    }

    // 清空排队中的播报（不影响当前正在读的这一句），用于切换阶段等需要跳过积压播报的场合
    function clearSpeechQueue() {
        speechQueue.length = 0;
    }

    function playBgm(phaseKey) {
        if (currentBgmKey === phaseKey) return;
        currentBgmKey = phaseKey;

        if (currentBgmEl) {
            currentBgmEl.pause();
            currentBgmEl = null;
        }

        if (!settings.bgmEnabled) return;

        const path = `/static/audio/bgm/${phaseKey}.mp3`;
        const el = new Audio(path);
        el.loop = true;
        el.volume = settings.bgmVolume;
        el.addEventListener('error', () => warnOnce(path), { once: true });
        currentBgmEl = el;

        if (unlocked) {
            el.play().catch(() => warnOnce(path));
        }
    }

    function stopBgm() {
        currentBgmKey = null;
        if (currentBgmEl) {
            currentBgmEl.pause();
            currentBgmEl = null;
        }
    }

    function playSfx(name) {
        if (!settings.sfxEnabled) return;
        const path = `/static/audio/sfx/${name}.mp3`;
        const el = new Audio(path);
        el.volume = settings.sfxVolume;
        el.addEventListener('error', () => warnOnce(path), { once: true });
        el.play().catch(() => warnOnce(path));
    }

    return {
        updateSettings,
        unlock,
        speak,
        speakAndWait,
        clearSpeechQueue,
        playBgm,
        stopBgm,
        playSfx
    };
})();
