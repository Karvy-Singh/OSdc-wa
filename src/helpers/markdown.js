const PROTECTED_MARKDOWN =
  /\\[\s\S]|(`+)[\s\S]*?\1|<(?:https?:\/\/|mailto:)[^\s<>]+>|(?:https?:\/\/|mailto:)[^\s<>]+|\]\((?:\\.|[^()\n]|\([^)]*\))*\)/gi;

function convertMarkdown(text, rules) {
  const protectedValues = [];
  const protect = (value) => {
    const token = `\0MARKDOWN_${protectedValues.length}\0`;
    protectedValues.push(value);
    return token;
  };

  text = text.replace(PROTECTED_MARKDOWN, protect);
  for (const [pattern, opening, closing] of rules) {
    text = text.replace(pattern, (_, content) => protect(`${opening}${content}${closing}`));
  }

  return text.replace(
    /\0MARKDOWN_(\d+)\0/g,
    (_, index) => protectedValues[Number(index)]
  );
}

function whatsappToDiscordMarkdown(text) {
  return convertMarkdown(text, [
    [/(?<![_*])_\*([^*\s](?:[^*\n]*?[^*\s])?)\*_(?![_*])/g, "***", "***"],
    [/(?<!\*)\*([^*\s](?:[^*\n]*?[^*\s])?)\*(?!\*)/g, "**", "**"],
    [/(?<!~)~([^~\s](?:[^~\n]*?[^~\s])?)~(?!~)/g, "~~", "~~"],
  ]);
}

function discordToWhatsAppMarkdown(text) {
  return convertMarkdown(text, [
    [/(?<!\*)\*{3}([^*\s](?:[^*\n]*?[^*\s])?)\*{3}(?!\*)/g, "_*", "*_"],
    [/(?<!\*)\*{2}([^*\s](?:[^*\n]*?[^*\s])?)\*{2}(?!\*)/g, "*", "*"],
    [/(?<!\*)\*([^*\s](?:[^*\n]*?[^*\s])?)\*(?!\*)/g, "_", "_"],
    [/(?<!~)~{2}([^~\s](?:[^~\n]*?[^~\s])?)~{2}(?!~)/g, "~", "~"],
  ]);
}

module.exports = { discordToWhatsAppMarkdown, whatsappToDiscordMarkdown };
