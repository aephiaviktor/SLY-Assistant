function GM() { }
GM.getValue = function(key,defaultVal) {
    let val=localStorage.getItem(key);
    if(val===null) return(defaultVal);
    return(val);
};
GM.setValue = function(key,val) {
	localStorage.setItem(key,val);
};
GM.deleteValue = function(key) {
    localStorage.removeItem(key);
}
GM.listValues = function() {
	return(Object.keys(localStorage));
};
window.GM = GM;
window.GM_listValues = GM.listValues;
window.SLYA_isStandalone = true;

