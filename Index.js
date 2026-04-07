import {
  Client,
  GatewayIntentBits,
  AttachmentBuilder,
  REST,
  Routes,
  SlashCommandBuilder,
} from "discord.js";
import Replicate from "replicate";
import FormData from "form-data";
import sharp from "sharp";

const commands = [
  new SlashCommandBuilder()
    .setName("enhance")
    .setDescription("Enhance a shoe photo for Vinted")
    .addAttachmentOption((option) =>
      option.setName("image").setDescription("Image").setRequired(true)
    )
    .toJSON(),
];

const TOKEN = process.env.TOKEN;
const CLIPDROP_KEY = process.env.CLIPDROP_KEY;
const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  const rest = new REST({ version: "10" }).setToken(TOKEN);

  for (const [guildId] of client.guilds.cache) {
    await rest.put(Routes.applicationGuildCommands(client.user.id, guildId), {
      body: commands,
    });
  }
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== "enhance") return;

  const attachment = interaction.options.getAttachment("image", true);

  await interaction.deferReply();

  const imgRes = await fetch(attachment.url);
  const rawBuffer = Buffer.from(await imgRes.arrayBuffer());

  const inputBuffer = await sharp(rawBuffer)
    .resize({ width: 768, height: 768, fit: "inside" })
    .png()
    .toBuffer();

  let cleanedBuffer = inputBuffer;

  if (REPLICATE_API_TOKEN) {
    const replicate = new Replicate({ auth: REPLICATE_API_TOKEN });

    const output = await replicate.run(
      "stability-ai/sdxl:da77bc59ee60423279fd632efb4795ab731d9e3ca9705ef3341091fb989b7eaf",
      {
        input: {
          image: `data:image/png;base64,${inputBuffer.toString("base64")}`,
          prompt: "clean shoe, product photo",
        },
      }
    );

    const imageUrl = Array.isArray(output) ? output[0] : output;
    const cleanedRes = await fetch(imageUrl);
    cleanedBuffer = Buffer.from(await cleanedRes.arrayBuffer());
  }

  const finalBuffer = await sharp(cleanedBuffer).sharpen().png().toBuffer();

  const file = new AttachmentBuilder(finalBuffer, { name: "result.png" });

  await interaction.editReply({ files: [file] });
});

client.login(TOKEN);
