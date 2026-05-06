#script

templist = "@@{Game.TEMPLATES}@@"
lookingFor = "start"

# Découper la chaîne en éléments (ici, séparés par une virgule et un espace)
elements = [elem.strip() for elem in templist.split(',')]

# Filtrer les éléments contenant 'summary'
goodElements = [elem for elem in elements if lookingFor in elem]

# Afficher les éléments filtrés, séparés par une virgule
print(', '.join(goodElements))