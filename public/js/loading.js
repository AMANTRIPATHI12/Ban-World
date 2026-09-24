const weakWords = [
    "VERY GOOD",
    "VERY BAD",
    "VERY HAPPY",
    "VERY SMART",
    "VERY BIG",
    "VERY FAST"
];

const strongWords = [
    "EXCEPTIONAL",
    "TERRIBLE",
    "DELIGHTED",
    "BRILLIANT",
    "MASSIVE",
    "RAPID"
];

const statusMessages = [
    "Training vocabulary warriors...",
    "Eliminating weak vocabulary...",
    "Building stronger sentences...",
    "Preparing the battlefield...",
    "Loading BanWorld..."
];

const weakEl = document.getElementById("weakWord");
const strongEl = document.getElementById("strongWord");
const statusEl = document.getElementById("battleStatus");
const progressEl = document.getElementById("loadingProgress");
const percentEl = document.getElementById("loadingPercent");
const loadingScreen = document.getElementById("loadingScreen");

let battleIndex = 0;
let progress = 0;
let serverReady = false;

function animateBattle() {

    weakEl.classList.remove("word-defeated");

    weakEl.textContent =
        weakWords[battleIndex % weakWords.length];

    strongEl.textContent =
        strongWords[battleIndex % strongWords.length];

    statusEl.textContent =
        statusMessages[battleIndex % statusMessages.length];

    setTimeout(() => {
        weakEl.classList.add("word-defeated");
    }, 1200);

    battleIndex++;
}

setInterval(animateBattle, 2200);
animateBattle();

function fakeProgress(){

    if(serverReady){
        progress = 100;
    }
    else{
        if(progress < 95){
            progress += Math.random() * 8;
        }
    }

    progressEl.style.width = progress + "%";
    percentEl.textContent =
        Math.floor(progress) + "%";

    if(progress >= 100){
        setTimeout(() => {
            loadingScreen.classList.add("loading-hide");

            setTimeout(() => {
                loadingScreen.remove();
            },800);

        },500);
    }
}

setInterval(fakeProgress,300);

async function waitForBackend(){

    while(true){

        try{

            const res = await fetch("/api/health");

            if(res.ok){

                serverReady = true;
                break;
            }

        }catch(err){}

        await new Promise(r => setTimeout(r,3000));
    }
}

waitForBackend();