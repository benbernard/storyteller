/** Inworld voice descriptions require ASCII; narration and source text do not. */
export function voiceDesignPrompt(value) {
 if(typeof value!=='string')throw Error('Voice design brief must be English text');
 const latin={Æ:'AE',æ:'ae',Œ:'OE',œ:'oe',Ø:'O',ø:'o',Ł:'L',ł:'l',Ð:'D',ð:'d',Đ:'D',đ:'d',Þ:'Th',þ:'th',ß:'ss',ẞ:'SS'};
 const prompt=value
  .replace(/[ÆæŒœØøŁłÐðĐđÞþßẞ]/gu,letter=>latin[letter])
  .normalize('NFKD').replace(/\p{M}/gu,'')
  .replace(/[\u2018\u2019\u201a\u201b\u2032\u2035\u02bc]/gu,"'")
  .replace(/[\u201c\u201d\u201e\u201f\u2033\u2036]/gu,'"')
  .replace(/[\u2010-\u2015\u2212\u2022]/gu,'-')
  .replace(/\u2026/gu,'...')
  .replace(/\r\n?/gu,'\n')
  .replace(/[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu,' ')
  .replace(/\p{Cf}/gu,'')
  .replace(/[^\S\n]+/gu,' ')
  .split('\n').map(line=>line.trim()).join('\n').trim();
 if(/[^\x20-\x7e\n]/u.test(prompt))throw Error('Voice design brief contains unsupported non-English characters');
 if(!/[A-Za-z]{2}/u.test(prompt))throw Error('Voice design brief must contain a nonempty English description');
 return prompt;
}
