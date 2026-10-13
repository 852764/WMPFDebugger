import { ObservedRequest } from "./discovery-data";
// Read-only requests observed during real debugging, never model-invented endpoints.
// A recipe obtains fresh evidence; it is not a permanent "no sales" blacklist.
export const probeRecipes:{appId:string;name:string;request:Omit<ObservedRequest,"route"|"tab"|"encoding">;pagination:{requestPath:string;currentPagePath:string;totalPagesPath:string;maxPages:number}}[]=[
    {appId:"wxcad251ff3aba93a9",name:"新发通讯",request:{
        url:"https://wcxf.m.9yun.com/small-oa/api/product/search",method:"POST",
        headers:{"content-type":"application/json"},
        data:{coll:"0-0-0-0-0_0",currentPage:1,keyword:"",isPid:true,productId:"",searchType:1},
        scopeEvidence:"Previously observed full product search: empty keyword/productId and all-category coll=0-0-0-0-0_0; verify current response.",
        priceEvidence:"Previously verified listing price is displayed in yuan. Do not treat commentCount or inventory as sales."
    },pagination:{requestPath:"currentPage",currentPagePath:"data.product.currentPage",totalPagesPath:"data.product.totalPage",maxPages:500}}
];
