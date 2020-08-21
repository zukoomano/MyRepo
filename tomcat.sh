yum install wget -y
wget https://mirrors.estointernet.in/apache/[...]/ApacheDirectoryStudio-2.0.0.v20200411-M15-linux.gtk.x86_64.tar.gz
tar -xvzf ApacheDirectoryStudio-2.0.0.v20200411-M15-linux.gtk.x86_64.tar.gz
cd Apache*
chmod +x shutdown.sh
chmod +x startup.sh
./startup.sh 
