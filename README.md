# Watsapp

Watsapp imports photos from a WhatsApp group's **Media → This month** section into a folder you choose. It uses local OCR to name each original image with the date and store printed on the receipt.

## Import this month's receipts

1. Install Node.js 22.12 or later. Open a terminal in the repository and run `npm ci`.
2. Run the command below with your exact group name and destination folder. Use a folder dedicated to receipts. Watsapp creates it if needed. If multiple groups have the same name, use `npm start -- --list-groups` to find the ID ending in `@g.us` and use that ID instead.
3. The first time, scan the QR code from **WhatsApp → Linked devices → Link a device** on your phone. Watsapp imports this month's gallery photos, prints a summary, and exits.

```powershell
npm start -- --group "My Receipt Group" --folder "C:\Users\YourName\Documents\Receipts"
```

Use `npm.cmd` in place of `npm` if PowerShell blocks the npm script. Run the command again whenever you want to refresh the folder. Watsapp reuses the linked session. It uses [whatsapp-web.js](https://docs.wwebjs.dev/), an unofficial WhatsApp Web integration that can break when WhatsApp changes its web client.

Add `--show-browser` to scan the QR code in a WhatsApp Web window.

## Saved photos

- A receipt might be saved as `2026-11-05 - Fresh Market - a1b2c3d4e5f67890.jpg`. The suffix distinguishes receipts from the same store on the same date and prevents the same message from being saved twice.
- The gallery month determines which photos to import. The filename uses the printed receipt date, which can fall in a different month. Ambiguous numeric dates use day/month/year.
- If the date row is clipped and two OCR passes agree on the visible day, Watsapp uses the gallery month and year and reports that inference.
- Photos with an unreadable date keep a `review-...` filename. If the date is readable but the store is missing, the filename contains `store-unknown`.
- Watsapp reports gallery photos it couldn't download. It processes images on your computer and saves their original bytes. The first OCR run downloads English language data.
