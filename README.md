# Watsapp

Watsapp watches a WhatsApp group for new photos and saves them to a folder you choose. It uses local OCR to read the receipt date and store name, then renames the original image.

## Set up receipt capture

1. Install Node.js 22 or later. Open a terminal in the repository and run `npm ci`.
2. Run `npm start -- --list-groups`. The first time, scan the QR code from **WhatsApp → Linked devices → Link a device** on your phone. Copy the ID ending in `@g.us` for the group you want.
3. Run the command below with your group ID and destination folder. Use a folder dedicated to receipts. Watsapp creates it if needed.

```powershell
npm start -- --group "123456789012345678@g.us" --folder "C:\Users\YourName\Documents\Receipts"
```

Use `npm.cmd` in place of `npm` if PowerShell blocks the npm script. Keep the program running to capture new photos. Press Ctrl+C to stop. The linked session is reused on restart. Watsapp uses [whatsapp-web.js](https://docs.wwebjs.dev/), an unofficial WhatsApp Web integration that can break when WhatsApp changes its web client.

## Saved photos

- A receipt might be saved as `2026-11-05 - Fresh Market - a1b2c3d4e5f67890.jpg`. The suffix distinguishes receipts from the same store on the same date and prevents the same message from being saved twice.
- The OCR looks for an English receipt header and transaction date. Ambiguous numeric dates use day/month/year. Photos with missing or unrecognized details keep a `review-...` filename. This includes other photos posted to the selected group.
- Watsapp saves the original bytes before reading the image. If OCR fails or the program stops during OCR, the image keeps a `pending-...` filename and is retried the next time Watsapp starts with that folder.
- Watsapp handles photos sent as images while it is running. It uses the linked account to download them from WhatsApp and processes them on your computer. The first OCR run downloads English language data.
