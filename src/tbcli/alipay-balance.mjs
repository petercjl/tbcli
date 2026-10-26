import {financeError,cents} from './finance-core.mjs';
const yuan=n=>`${n<0n?'-':''}${(n<0n?-n:n)/100n}.${String((n<0n?-n:n)%100n).padStart(2,'0')}`;
function amount(v){const s=String(v??'');if(!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(s))throw financeError('ALIPAY_BALANCE_SCHEMA_CHANGED','支付宝余额金额字段不可用。');return yuan(cents(s.replaceAll(',','')));}
export function normalizeAlipayBalance(response,accountId){
 if(response?.success!==true)throw financeError('ALIPAY_RESPONSE_FAILED','支付宝资金总览未成功返回。');
 const data=response.data?.data;const rows=data?.fund_home_detail_info?.data?.alipayBalanceList;
 if(!Array.isArray(rows))throw financeError('ALIPAY_BALANCE_SCHEMA_CHANGED','资金总览账户列表结构变化。');
 const matches=rows.filter(r=>String(r.userId)===String(accountId));
 if(matches.length!==1)throw financeError('ACCOUNT_SCOPE_MISMATCH','资金总览未唯一返回指定支付宝账户。');
 const available=amount(matches[0].availableBalance),frozen=amount(matches[0].frozenBalance);
 const overview=data?.fund_home_overview?.data;
 return {accountId:String(accountId),total:yuan(cents(available)+cents(frozen)),available,frozen,withdrawing:null,
  sourceRef:'alipay:mrchcenter.artisan.v2.ext.query:fund_home_detail_info',
  evidence:{accountId:String(accountId),availableBalance:available,frozenBalance:frozen,reportedOverviewTotal:overview?.totalAmount==null?null:amount(overview.totalAmount)},
  relatedAccounts:overview?.bailAmount==null?[]:[{kind:'deposit',displayedAmount:amount(overview.bailAmount),includedInTotal:false,note:'另列保证金，不与支付宝现金余额重复相加。'}]};
}
