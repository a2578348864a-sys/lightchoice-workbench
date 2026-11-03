/** Read only the visible competitor card with an exact ASIN label, never sibling variants. */
export function collectSellerSpriteSubjectCards(asin: string): Array<{asin:string;text:string}> {
 return Array.from(document.querySelectorAll<HTMLElement>(".relation-card")).filter(card => {
  const rect=card.getBoundingClientRect();const style=getComputedStyle(card);
  return rect.width>0&&rect.height>0&&style.display!=="none"&&style.visibility!=="hidden"&&card.querySelector(".asin")?.textContent?.trim()===asin;
 }).slice(0,2).map(card=>({asin,text:card.innerText.slice(0,10000)}));
}

export function projectSellerSpriteSubjectCard(cards: readonly {asin:string;text:string}[],asin:string):Record<string,unknown> {
 const matches=cards.filter(card=>card.asin===asin&&card.text.split(/\r?\n/u).some(line=>line.trim()===asin));
 if(matches.length!==1)return {};
 const text=matches[0].text.normalize("NFKC"),product:Record<string,unknown>={};
 const price=[...text.matchAll(/(?:^|\n)价格:\s*\$([\d,]+(?:\.\d+)?)\s*(?=\n|$)/gu)];
 const ratings=[...text.matchAll(/(?:^|\n)评分\/评分数:\s*(\d(?:\.\d+)?)\s*\/\s*([\d,]+)\s*(?=\n|$)/gu)];
 if(price.length===1){const amount=Number(price[0][1].replaceAll(",",""));if(Number.isFinite(amount)&&amount>=0)product.price={amount,currency:"USD"};}
 if(ratings.length===1){const rating=Number(ratings[0][1]),reviewCount=Number(ratings[0][2].replaceAll(",",""));if(rating>=0&&rating<=5)product.rating=rating;if(Number.isSafeInteger(reviewCount)&&reviewCount>=0)product.reviewCount=reviewCount;}
 // Parent sales and approximate child-sales bands remain raw card evidence, never target-ASIN sales.
 return product;
}

/** Explicit visible table columns only. Never infer numbers from charts, screenshots or row positions. */
export function projectSellerSpriteSubjectTables(tables: readonly {headers: readonly string[];rows: readonly (readonly (string|null)[])[]}[],asin:string,allowUnkeyedDates=false){
 const normalize=(s:string)=>s.normalize('NFKC').replace(/[\s_$()（）]/gu,'').toLowerCase();
 const aliases:Record<string,string[]>={asin:['asin','商品asin'],date:['日期','时间','date','month','月份'],price:['价格','price','售价'],rating:['评分','rating'],reviewCount:['评论数','reviewcount','reviews'],monthlySales:['月销量','monthlysales'],searchVolume:['搜索量','月搜索量','searchvolume'],bsr:['bsr','排名'],sales:['销量','sales']};
 const number=(v:unknown)=>{if(typeof v!=='string'||!/^\s*(?:US\$|\$)?\d[\d,]*(?:\.\d+)?\s*$/u.test(v))return null;const n=Number(v.replace(/US\$|[$,\s]/gu,''));return Number.isFinite(n)?n:null;};
 const product:Record<string,unknown>={};const series:Record<string,unknown>[]=[];
 for(const table of tables){
  const column=(key:string)=>{const ids=table.headers.flatMap((h,i)=>aliases[key].some(a=>normalize(a)===normalize(h))?[i]:[]);return ids.length===1?ids[0]:-1;};
  const ai=column('asin'),di=column('date');
  if(ai<0&&!allowUnkeyedDates)continue;
  for(const row of table.rows.slice(0,100)){
   if(ai>=0&&row[ai]?.trim().toUpperCase()!==asin)continue;
   if(di>=0&&typeof row[di]==='string'&&/^\d{4}[-/]\d{2}(?:[-/]\d{2})?$/u.test(row[di]!.trim())){
    const date=row[di]!.trim().replaceAll('/','-');const parsed=new Date(`${date.length===7?`${date}-01`:date}T00:00:00Z`);if(!Number.isFinite(parsed.valueOf())||parsed.toISOString().slice(0,date.length)!==date)continue;const point:Record<string,unknown>={date};
    for(const field of ['price','rating','reviewCount','monthlySales','bsr','sales']){const v=number(row[column(field)]);if(v!==null)point[field]=v;}
    if(Object.keys(point).length>1)series.push(point);
   }else if(ai>=0){
    for(const field of ['price','rating','reviewCount']){const v=number(row[column(field)]);if(v!==null&&(!(field in product)||JSON.stringify(product[field])===JSON.stringify(field==='price'?{amount:v,currency:'USD'}:v)))product[field]=field==='price'?{amount:v,currency:'USD'}:v;else if(v!==null)product[field]=null;}
   }
  }
 }
 return {product,series};
}
