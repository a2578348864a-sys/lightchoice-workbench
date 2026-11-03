import {describe,it,expect} from "vitest";
import {projectSellerSpriteSubjectCard,projectSellerSpriteSubjectTables as project} from "./sellerSpriteSubjectTable";
const asin="B012345678";
describe("SellerSprite one-subject visible dates",()=>{
 it("reads exact-subject named competitor-card fields and excludes parent sales and child bands",()=>{const card={asin,text:`Product\n${asin}\n品牌: Brand\n销量(父): 14,895\n子体销量: 10K+\n价格: $9.98\n评分/评分数: 4.8/27,527\n上架时间: 2016-02-13`};expect(projectSellerSpriteSubjectCard([card],asin)).toEqual({price:{amount:9.98,currency:"USD"},rating:4.8,reviewCount:27527});expect(projectSellerSpriteSubjectCard([{...card,asin:"B087654321"}],asin)).toEqual({});expect(projectSellerSpriteSubjectCard([card,card],asin)).toEqual({});expect(projectSellerSpriteSubjectCard([{...card,text:card.text+"\n价格: $10.00"}],asin).price).toBeUndefined();});
 it("does not attribute other ASIN rows or anonymous history to the target",()=>{expect(project([{headers:["ASIN","价格"],rows:[["B087654321","9.99"]]}],asin).product).toEqual({});expect(project([{headers:["日期","月销量"],rows:[["2026-10","100"]]}],asin).series).toEqual([]);});
 it("requires real valid dates and numbers; never turns search volume into product history",()=>{const result=project([{headers:["日期","月销量","搜索量"],rows:[["2026-10","100","3000"],["2026-13","99","2000"],["2026-02-30","99","2000"],["2026-09","1.2K","2000"]]}],asin,true);expect(result.series).toEqual([{date:"2026-10",monthlySales:100}]);});
 it("keeps conflicting product values unknown and parses only explicit named fields",()=>{expect(project([{headers:["ASIN","价格","评分"],rows:[[asin,"$19.99","4.5"],[asin,"$29.99","4.5"],[asin,"$19.99","4.5"]]}],asin).product).toEqual({price:null,rating:4.5});});
});
