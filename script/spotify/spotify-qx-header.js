// Original work: https://github.com/app2smile/rules (c) 2023 app2smile, MIT License. See ./LICENSE
let headers = $request.headers;
delete headers['If-None-Match'];
console.log('2025.03.20-qx-spotify删除请求头')
$done({headers});
