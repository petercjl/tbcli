export const AUDIENCE_TYPES = Object.freeze({purchase:{code:'4',label:'购买'},browse:{code:'1',label:'浏览'},favorite:{code:'2',label:'收藏'},cart:{code:'3',label:'加购'},search:{code:'5',label:'搜索'}});
export const AUDIENCE_DIMENSIONS = Object.freeze([
  {id:'gender',label:'性别',tagId:114554}, {id:'age',label:'年龄',tagId:114555},
  {id:'consumption',label:'购买力',tagId:163535}, {id:'city',label:'城市等级',tagId:213510},
  {id:'segments',label:'大快消策略人群',tagId:266238,multiLabel:true},
]);
export const AUDIENCE_CONTRACT = Object.freeze({version:1,command:'dmp audience',path:'/api/dmp/insight/tag/chart',method:'POST',days:[7,15,30,90],defaultDays:30,types:AUDIENCE_TYPES,defaultType:'purchase',dimensions:AUDIENCE_DIMENSIONS,periodType:'rolling',dateCoverage:'not echoed; no historic start/end',ownedContextRequired:false});
