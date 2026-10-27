/** Shared, conservative cleanup for caption text, before translation and display. */
var YTD_TRANSCRIPT_CLEANUP = (() => {
  const VERSION = 1;
  const CUE = "\uE000";
  const FILLER = "\uE001";
  const MUSIC_NOTES = /[♪♫♬♩]/g;
  const PROTECTED_PARTS = /```[\s\S]*?```|`[^`\n]*`|"[^"\n]*"|“[^”\n]*”|‘[^’\n]*’|「[^」\n]*」|『[^』\n]*』|(?<![\p{L}\p{N}])'[^'\n]*'(?![\p{L}\p{N}])|\[[^\]\n]*\]|\([^()\n]*\)|【[^】\n]*】|（[^（）\n]*）|［[^］\n]*］/gu;
  const HAN = /\p{Script=Han}/u;
  const JAPANESE_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー々]/u;
  const WORD = /[\p{L}\p{N}_]/u;

  function isSoundLabel(label) {
    const value = label.trim().toLowerCase().replace(/[.!。！]+$/, "").trim();
    if (!value) return false;

    // Exact, bounded labels only: descriptions, titles, code, and mathematical
    // expressions inside brackets must remain part of the transcript.
    const englishMusic = /^(?:(?:background|soft|gentle|quiet|loud|upbeat|dramatic|instrumental|intro|outro|ambient|ominous|cheerful|sad|tense)\s+)*music(?:\s+(?:playing|plays|starts|stops|fades(?:\s+(?:in|out))?))?$/;
    const englishSound = /^(?:(?:audience|crowd|people)\s+)?(?:laughter|laughing|laughs|chuckling|chuckles|applause|clapping|cheering|cheers|screaming|screams|scream|sighing|sighs|coughing|coughs|sobbing|crying|background noise|sound effects?|silence)$/;
    const chineseSound = /^(?:(?:背景|轻柔|轻快|悲伤|欢快|紧张|激昂|舒缓)音乐|音乐(?:响起|播放|渐弱|渐强|停止)?|配乐|伴奏|笑声|大笑|轻笑|观众笑声|掌声|鼓掌|欢呼|欢呼声|尖叫|尖叫声|叹气|叹息|咳嗽|咳嗽声|哭声|啜泣|背景噪音|背景噪声|音效|静音|无声)$/;
    const japaneseSound = /^(?:音楽|背景音楽|拍手|笑い|笑い声|歓声|悲鳴|ため息|咳|咳払い|泣き声|すすり泣き|効果音|無音)$/;
    const koreanSound = /^(?:음악|배경 음악|배경음악|박수|웃음|웃음소리|환호|환호성|비명|한숨|기침|울음|울음소리|흐느낌|효과음|정적)$/;
    return value.split(/\s*(?:[,，、;/&]|\band\b)\s*/).every((part) =>
      englishMusic.test(part) || englishSound.test(part) || chineseSound.test(part) ||
      japaneseSound.test(part) || koreanSound.test(part),
    );
  }

  function removeFillers(text, language) {
    const languageCode = typeof language === "string" ? language.trim().toLowerCase() : "";
    const english = /^(?:en(?:[-_].*)?|english)$/.test(languageCode);
    const unknown = !languageCode || /^(?:und|unknown|auto)$/.test(languageCode);
    return text.replace(/\b(?:um|uh|erm|er)\b|呃+/giu, (token, offset, source) => {
      const before = source[offset - 1] || "";
      const after = source[offset + token.length] || "";
      // Preserve acronyms, units, names in compounds, and words such as uh-huh.
      if (/^[A-Z]+$/.test(token) || WORD.test(before) || WORD.test(after) ||
          /[-'’]/.test(before) || /[-'’]/.test(after) ||
          /\d\s*$/.test(source.slice(0, offset))) return token;
      if (!/^呃+$/u.test(token)) {
        // "er" and "um" are ordinary words in several other languages. A known
        // non-English track must never lose them to English filler cleanup.
        if (!english && !unknown) return token;
        if (unknown && /^(?:er|um)$/i.test(token)) {
          const prefix = source.slice(0, offset).replace(/[\uE000\uE001]/g, "").trimEnd();
          const suffix = source.slice(offset + token.length).trimStart();
          const initial = !prefix.trim() || /[.!?。！？]$/.test(prefix);
          const commaDelimited = /[,，]$/.test(prefix) && /^[,，]/.test(suffix);
          const hesitantEnding = /^(?:\.{2,}|…)/.test(suffix);
          if (!(initial && /^[,，]/.test(suffix)) && !commaDelimited && !hesitantEnding) return token;
        }
      }
      return FILLER;
    });
  }

  function cleanText(input, language) {
    if (typeof input !== "string") return "";
    const code = String(language || "").trim().toLowerCase();
    const japanese = /^(?:ja(?:[-_].*)?|jpn|japanese)$/.test(code) ||
      ((!code || /^(?:und|unknown|auto)$/.test(code)) && /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(input));
    const protectedText = [];
    let hadNoise = false;
    const protect = (value) => `\uE100${protectedText.push(value) - 1}\uE101`;
    let text = input.replace(PROTECTED_PARTS, (part) => {
      if (/^[\[（(【［]/u.test(part) && isSoundLabel(part.slice(1, -1))) {
        hadNoise = true;
        return CUE;
      }
      // Quoted speech, literal labels, and unknown brackets are left intact.
      return protect(part);
    });
    text = text.replace(MUSIC_NOTES, () => {
      hadNoise = true;
      return CUE;
    });
    text = removeFillers(text, language);
    if (text.includes(FILLER)) hadNoise = true;

    // A hesitation's commas belong to the hesitation; other sentence punctuation
    // stays in place. Sound labels do not consume meaningful adjacent commas.
    text = text.replace(/(?:[,，、]\s*)?\uE001(?:\s*[,，、])?/g, (match, offset, source) => {
      // Keep the separation in explicit answers/corrections: "Yes, uh, no."
      // must not turn into "Yes no." when the hesitation disappears.
      if (/^[,，、]/.test(match) && /[,，、]$/.test(match) &&
          /(?:\b(?:yes|no|yeah|nope|right|actually|sorry)|是的|不对|不是)$/i.test(source.slice(0, offset))) {
        return match[0];
      }
      return FILLER;
    });
    text = text.replace(/(?:[ \t]*[\uE000\uE001][ \t]*)+/g, (match, offset, source) => {
      const before = source[offset - 1] || "";
      const after = source[offset + match.length] || "";
      if (!before || !after || /[,.;:!?，。；：！？、)）】\]]/.test(after) ||
          /[(（【\[]/.test(before) || (HAN.test(before) && HAN.test(after)) ||
          (japanese && JAPANESE_CHAR.test(before) && JAPANESE_CHAR.test(after))) return "";
      return " ";
    });
    text = text.replace(/\s+/g, " ").trim();
    if (hadNoise) {
      const visible = text.replace(/<\/?(?:b|i|u|em|strong)>/gi, "");
      if (!/[\p{L}\p{N}\p{S}\uE100]/u.test(visible)) text = "";
      text = text.replace(/^[,.;:!?，。；：！？、…\s]+/, "").trim();
      if (!/[\p{L}\p{N}\p{S}\uE100]/u.test(text)) text = "";
    }
    return text.replace(/\uE100(\d+)\uE101/g, (_, index) => protectedText[Number(index)]);
  }

  function cleanupEntries(entries) {
    if (!Array.isArray(entries)) return [];
    return entries.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const text = cleanText(entry.text, entry.language || entry.lang);
      return text ? [{ ...entry, text }] : [];
    });
  }

  return Object.freeze({ VERSION, cleanText, cleanupEntries });
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = YTD_TRANSCRIPT_CLEANUP;
}
