"""
血染钟楼 - 语音合成 API

用 edge-tts（微软 Edge 浏览器的神经网络语音）在服务端生成语音，比浏览器自带的
speechSynthesis 自然得多，也不受浏览器"标签页不在前台就不出声"这类坑影响。
生成的音频按文本+音色缓存到本地文件，同一句话只会真正合成一次。
"""
import asyncio
import hashlib
import os

from flask import Blueprint, request, jsonify
import edge_tts

tts_bp = Blueprint('tts', __name__)

DEFAULT_VOICE = 'zh-CN-XiaoxiaoNeural'
ALLOWED_VOICES = {
    'zh-CN-XiaoxiaoNeural',  # 晓晓 - 温和女声（默认）
    'zh-CN-YunxiNeural',     # 云希 - 清朗男声
    'zh-CN-YunyangNeural',   # 云扬 - 新闻主播男声
    'zh-CN-XiaoyiNeural',    # 晓伊 - 活泼女声
}

CACHE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'static', 'audio', 'tts_cache')
os.makedirs(CACHE_DIR, exist_ok=True)


def _cache_filename(text, voice):
    key = hashlib.md5(f'{voice}:{text}'.encode('utf-8')).hexdigest()
    return f'{key}.mp3'


async def _generate(text, voice, path):
    communicate = edge_tts.Communicate(text, voice)
    await communicate.save(path)


@tts_bp.route('/api/tts', methods=['POST'])
def synthesize():
    """生成（或返回缓存好的）语音文件，返回可直接播放的 URL"""
    data = request.json or {}
    text = (data.get('text') or '').strip()
    voice = data.get('voice') or DEFAULT_VOICE

    if voice not in ALLOWED_VOICES:
        voice = DEFAULT_VOICE

    if not text:
        return jsonify({"error": "缺少文本"}), 400
    if len(text) > 200:
        return jsonify({"error": "文本过长"}), 400

    filename = _cache_filename(text, voice)
    path = os.path.join(CACHE_DIR, filename)

    if not os.path.exists(path):
        try:
            asyncio.run(_generate(text, voice, path))
        except Exception as e:
            return jsonify({"error": f"语音合成失败: {e}"}), 502

    return jsonify({
        "success": True,
        "url": f"/static/audio/tts_cache/{filename}"
    })
