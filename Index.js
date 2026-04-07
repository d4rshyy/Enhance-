import {
  Client,
  GatewayIntentBits,
  AttachmentBuilder,
  REST,
  Routes,
  SlashCommandBuilder,
  type Interaction,
} from "discord.js";
import Replicate from "replicate";
import FormData from "form-data";
import sharp from "sharp";
import { logger } from "./lib/logger.js";

const commands = [
  new SlashCommandBuilder()
    .setName("enhance")
    .setDescription("Enhance a shoe photo for Vinted (clean + relight + sharpen)")
    .addAttachmentOption((option) =>
      option
        .setName("image")
        .setDescription("The photo you want to enhance")
        .setRequired(true)
    )
    .toJSON(),
];

export function startBot() {
  const TOKEN = process.env["TOKEN"];
  const CLIPDROP_KEY = process.env["CLIPDROP_KEY"];
  const REPLICATE_API_TOKEN = process.env["REPLICATE_API_TOKEN"];

  if (!TOKEN) {
    logger.warn("TOKEN not set — Discord bot will not start");
    return;
  }

  if (!CLIPDROP_KEY) {
    logger.warn("CLIPDROP_KEY not set — background replacement will fail");
  }

  if (!REPLICATE_API_TOKEN) {
    logger.warn("REPLICATE_API_TOKEN not set — cleaning step will be skipped");
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
    ],
  });

  client.on("error", (err) => {
    logger.error({ err }, "Discord client error");
  });

  client.once("clientReady", async () => {
    logger.info({ tag: client.user?.tag, id: client.user?.id }, "Discord bot ready");

    try {
      const rest = new REST().setToken(TOKEN);
      const appId = client.user!.id;

      for (const [guildId, guild] of client.guilds.cache) {
        await rest.put(Routes.applicationGuildCommands(appId, guildId), {
          body: commands,
        });
        logger.info({ guild: guild.name }, "Slash commands registered in guild");
      }
    } catch (err) {
      logger.error({ err }, "Failed to register slash commands");
    }
  });

  client.on("interactionCreate", async (interaction: Interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== "enhance") return;

    const attachment = interaction.options.getAttachment("image", true);

    if (!attachment.contentType?.startsWith("image/")) {
      try {
        await interaction.reply({
          content: "Please attach an image file (JPG, PNG, etc.).",
          ephemeral: true,
        });
      } catch { /* interaction may have expired */ }
      return;
    }

    try {
      await interaction.deferReply();
    } catch (err) {
      logger.error({ err }, "Failed to defer reply — interaction expired");
      return;
    }

    try {
      // STEP 1: Download and resize to 768px
      const imgRes = await fetch(attachment.url);
      const rawBuffer = Buffer.from(await imgRes.arrayBuffer());
      const inputBuffer = await sharp(rawBuffer)
        .resize({ width: 768, height: 768, fit: "inside", withoutEnlargement: true })
        .png()
        .toBuffer();

      // STEP 2: Replicate Real-ESRGAN — clean up shoe (remove dirt, enhance texture)
      let cleanedBuffer = inputBuffer;
      if (REPLICATE_API_TOKEN) {
        try {
          const replicate = new Replicate({ auth: REPLICATE_API_TOKEN });
          const dataUri = `data:image/png;base64,${inputBuffer.toString("base64")}`;

          const output = await replicate.run(
            "stability-ai/sdxl:da77bc59ee60423279fd632efb4795ab731d9e3ca9705ef3341091fb989b7eaf",
            {
              input: {
                image: dataUri,
                prompt: "clean shoe, pristine condition, no dirt, no scuffs, no stains, smooth texture, professional product photo",
                negative_prompt: "dirt, stains, scuffs, scratches, worn, damaged, dust",
                prompt_strength: 0.25,
                num_inference_steps: 30,
                guidance_scale: 7.5,
              },
            }
          );

          const imageUrl = Array.isArray(output) ? String(output[0]) : String(output);
          const cleanedRes = await fetch(imageUrl);
          cleanedBuffer = Buffer.from(await cleanedRes.arrayBuffer());
          logger.info("Replicate cleanup complete");
        } catch (err) {
          logger.error({ err }, "Replicate cleanup failed, continuing without it");
        }
      }

      // STEP 3: Sharp — studio look (brighten, colour boost, contrast, sharpen)
      const litBuffer = await sharp(cleanedBuffer)
        .modulate({ brightness: 1.25, saturation: 1.05 })
        .linear(1.15, -15)
        .sharpen()
        .png()
        .toBuffer();

      // STEP 4: ClipDrop replace-background (1 credit)
      const form = new FormData();
      form.append("image_file", litBuffer, {
        filename: "lit.png",
        contentType: "image/png",
      });
      form.append("prompt", "clothing flat lay, plain white background, soft natural shadow directly beneath item, bright even lighting, realistic product photo, no gradients or props");

      const bgRes = await fetch("https://clipdrop-api.co/replace-background/v1", {
        method: "POST",
        headers: {
          "x-api-key": CLIPDROP_KEY ?? "",
          ...form.getHeaders(),
        },
        body: form.getBuffer(),
      });

      if (!bgRes.ok) {
        const errText = await bgRes.text();
        logger.error({ status: bgRes.status, err: errText }, "Background replacement failed");
        throw new Error(`Background replacement failed: ${bgRes.status} ${errText}`);
      }

      const finalBuffer = Buffer.from(await bgRes.arrayBuffer());

      const file = new AttachmentBuilder(finalBuffer, { name: "vinted-pro.png" });
      await interaction.editReply({
        content: "Done ✅ Cleaned (Replicate) → Studio lighting (Sharp) → White BG (ClipDrop: 1 credit) — ready for Vinted!",
        files: [file],
      });
    } catch (err) {
      logger.error({ err }, "Error processing image");
      const errMsg = err instanceof Error ? err.message : "Unknown error";
      try {
        await interaction.editReply(`Error ❌ ${errMsg}`);
      } catch { /* interaction may have expired */ }
    }
  });

  client.login(TOKEN).catch((err) => {
    logger.error({ err }, "Failed to login to Discord");
  });
  }
