module.exports = { getGroups, getProfilePic, downloadMedia };

// NOTE: to anyone working on the code, do not use .getchats() or .getProfilePicUrl(), 
// that throws an error (r:r) with some new changes in wa, 
// and it is not yet fixed in upstream

async function getGroups(client) {
  return client.pupPage.evaluate(() =>
    window.require("WAWebCollections").Chat
      .getModelsArray()
      .map(chat => ({
        id: chat.id?.toString?.(),
        name: chat.formattedTitle || chat.name || "Unnamed group",
      }))
      .filter(chat => chat.id?.endsWith("@g.us"))
  );
}

async function getProfilePic(client, contactId) {
  return client.pupPage.evaluate(async (id) => {
    try {
      const wid = window.require("WAWebWidFactory").createWid(id);
      const pictures = window.require("WAWebCollections").ProfilePicThumb;

      const picture = pictures.get(wid) || (await pictures.find(wid));

      return picture?.eurl;
    } catch {
      return undefined;
    }
  }, contactId);
}

async function downloadMedia(message) {
  if (!message.hasMedia) return undefined;

  const remote =
    typeof message.id.remote === "string"
      ? message.id.remote
      : message.id.remote?._serialized || message.id.remote?.$1;

  const messageId =
    message.id._serialized ||
    message.id.$1 ||
    `${message.id.fromMe}_${remote}_${message.id.id}`;

  message.id._serialized = messageId;
  return message.downloadMedia();
}

