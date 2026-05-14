import { loadTtsModel } from "./dist/index.js";

async function main() {
    const tts = await loadTtsModel("");
    await tts.synthesize({
        text: "Hello world",
    });
}

main()
