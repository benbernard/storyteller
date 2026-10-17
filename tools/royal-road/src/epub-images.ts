import sharp from 'sharp';
import { verifyImage } from './network.js';

sharp.concurrency(1);
sharp.cache({memory:32,files:0,items:16});
/** Keep original downloaded bytes in the archive. Convert formats outside EPUB's
 * core image set for readers that cannot display WebP or AVIF. */
export async function epubImage(bytes: Buffer): Promise<{bytes:Buffer;mime:string;extension:string}> {
  const mime=verifyImage(bytes);
  const extension=({'image/jpeg':'jpg','image/png':'png','image/gif':'gif','image/svg+xml':'svg'} as Record<string,string>)[mime];
  if(extension)return {bytes,mime,extension};
  if(mime!=='image/webp'&&mime!=='image/avif')throw new Error('Unsupported EPUB image format.');
  const image=sharp(bytes,{animated:true,limitInputPixels:64_000_000,failOn:'error'}).timeout({seconds:30});
  const metadata=await image.metadata();
  if((metadata.pages??1)>1) {
    const result=await image.gif().toBuffer();
    return {bytes:result,mime:'image/gif',extension:'gif'};
  }
  const result=await image.autoOrient().png({compressionLevel:9}).toBuffer();
  return {bytes:result,mime:'image/png',extension:'png'};
}
